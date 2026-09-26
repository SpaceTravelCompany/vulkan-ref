---
title: Queries
slug: queries
---

## 소개

`VkQueryPool`은 GPU가 측정한 수치를 CPU로 가져오는 통로다. 오클루전(Occlusion, 픽셀 가시성), GPU 타임스탬프, 파이프라인 단계별 통계 카운터 등을 수집한다.

> **용어 정리**
> - **Query Pool**: 미리 할당하는 쿼리 슬롯 집합(`VkQueryPool`).
> - **Begin/End**: 오클루전과 파이프라인 통계 쿼리는 `vkCmdBeginQuery`와 `vkCmdEndQuery`로 측정 구간을 지정.
> - **Write Timestamp**: 타임스탬프는 `vkCmdWriteTimestamp`로 특정 시점 하나만 기록.
> - **Reset**: 풀의 쿼리 슬롯을 초기화. `vkCmdResetQueryPool`(명령어)을 호출하거나 생성 시 `VK_QUERY_POOL_CREATE_RESET_BIT_KHR` 플래그 지정.
> - **Result Flags**: CPU가 결과를 읽을 때 적용하는 데이터 형식과 대기 정책(`64_BIT`, `WAIT_BIT`, `WITH_AVAILABILITY_BIT`, `PARTIAL_BIT`).

이 문서는 **생성 → 기록 → 제출 → 결과 수집** 흐름과 실무에서 자주 발생하는 주의사항을 정리한다.

---

## 1. 전체 흐름

```flowchart
flowchart TD
  A["VkQueryPool 생성 (type, count)"]
  B["[vkCmdResetQueryPool] — 슬롯 초기화"]
  C["구간 측정:"]
  D(["vkCmdBeginQuery (occlusion / pipeline_statistics)"])
  E["... draw / dispatch ..."]
  F(["vkCmdEndQuery"])
  G["시점 기록:"]
  H(["vkCmdWriteTimestamp (timestamp)"])
  I(["vkQueueSubmit + fence"])
  J["CPU 결과 조회:"]
  K(["vkGetQueryPoolResults(pool, flags)"])
  A --> B --> C
  C --> D --> E --> F
  C --> G --> H
  F --> I
  H --> I
  I --> J --> K
```

**핵심 요약:**

- 쿼리 결과 수집은 **GPU 비동기** 작업이다. CPU가 `vkGetQueryPoolResults`를 호출할 때 GPU 처리가 끝나지 않았다면 `VK_QUERY_RESULT_WAIT_BIT`를 지정하거나 펜스(Fence)로 동기화해야 한다.
- `OCCLUSION`은 **그래픽스 큐**에서만 시작할 수 있다(VUID-vkCmdBeginQuery-queryType-00803). `PIPELINE_STATISTICS`는 켠 카운터 종류에 따라 요구 큐가 다르다 — 그래픽스 카운터만 켰으면 그래픽스 큐, 컴퓨트 카운터만 켰으면 컴퓨트 큐에서 허용된다(VUID-vkCmdBeginQuery-queryType-00804/00805).
- `PIPELINE_STATISTICS`를 사용하려면 `pipelineStatisticsQuery` 기능을 활성화해야 한다(VUID-VkQueryPoolCreateInfo-queryType-00791).

---

## 2. `VkQueryPoolCreateInfo` — 쿼리 풀 생성

```c
typedef struct VkQueryPoolCreateInfo {
    VkStructureType                  sType;
    const void*                      pNext;
    VkQueryPoolCreateFlags           flags;
    VkQueryType                      queryType;
    uint32_t                         queryCount;
    VkQueryPipelineStatisticFlags    pipelineStatistics;  // PIPELINE_STATISTICS일 때만 지정
} VkQueryPoolCreateInfo;
```

### 2.1. `queryType` 종류

| 값 | 수집 내용 | 필요 기능/확장 | 비고 |
|----|----------|--------------|------|
| `OCCLUSION` | 깊이/스텐실 테스트를 통과한 샘플 수 | 없음 | 그래픽스 큐 전용 |
| `TIMESTAMP` | 특정 시점의 GPU 타임라인 클럭 | 없음 | `timestampValidBits > 0`인 큐에서만 지원 |
| `PIPELINE_STATISTICS` | 파이프라인 단계별 호출 카운터 | `pipelineStatisticsQuery` | 그래픽스/컴퓨트 큐 |
| `TRANSFORM_FEEDBACK_*` | 트랜스폼 피드백 카운터 | `VK_EXT_transform_feedback` | 확장 전용 (코어 승격 없음) |
| `PERFORMANCE_QUERY_KHR` | 하드웨어 프로파일링 카운터 | `VK_KHR_performance_query` | pNext 구조체 필요 |
| `ACCELERATION_STRUCTURE_COMPACTED_SIZE_*` | 가속 구조 압축 크기 | 레이 트레이싱 확장 | — |
| `RESULT_STATUS_ONLY_KHR` | 비디오 인코딩 결과 상태 | `VK_KHR_video_queue` | 비디오 큐 전용 |
| `VIDEO_ENCODE_FEEDBACK_KHR` | 비디오 인코딩 피드백 | `VK_KHR_video_encode_queue` | 비디오 큐 전용 |

> **스펙 발췌 (VUID-VkQueryPoolCreateInfo-queryType-00791)** `pipelineStatisticsQuery` 기능이 활성화되지 않았다면 `queryType`에 `VK_QUERY_TYPE_PIPELINE_STATISTICS`를 지정할 수 없다.
>> 기능이 꺼져 있으면 풀 생성 단계에서 바로 실패한다.

> **스펙 발췌 (VUID-VkQueryPoolCreateInfo-queryType-09534)** `queryType`이 `PIPELINE_STATISTICS`인 경우 `pipelineStatistics` 플래그는 0이 아니어야 한다.
>> 최소 1개 이상의 통계 카운터 비트를 켜야 한다.

> **스펙 발췌 (VUID-VkQueryPoolCreateInfo-queryType-03222)** `queryType`이 `PERFORMANCE_QUERY_KHR`인 경우 pNext 체인에 `VkQueryPoolPerformanceCreateInfoKHR` 구조체가 포함되어야 한다.

### 2.2. `flags` — `RESET_BIT_KHR`

`VK_QUERY_POOL_CREATE_RESET_BIT_KHR`(`VK_KHR_maintenance9`): Vulkan 1.4 시기에 추가된 최신 디바이스 확장으로(1.4 코어 승격이 아니므로 디바이스 생성 시 명시적 활성화 필요), 풀 생성 시 모든 쿼리 슬롯을 초기화된(unavailable) 상태로 만든다. **첫 사용 전에 `vkCmdResetQueryPool`을 별도로 호출하지 않아도 된다.** 풀을 재사용할 때 매번 초기화 명령을 기록하는 번거로움을 덜어준다.

---

## 3. `vkCmdBeginQuery` / `vkCmdEndQuery` — 구간 측정

오클루전과 파이프라인 통계 쿼리는 측정 구간을 begin/end로 감싼다. 두 호출 사이에서 실행된 모든 드로우 및 디스패치 작업이 카운터에 반영된다.

```c
// 오클루전: 구간 내부 draw 명령이 렌더링한 샘플 수 측정
vkCmdBeginQuery(cmd, pool, queryIdx, VK_QUERY_CONTROL_PRECISE_BIT);  // 또는 0
vkCmdDraw(cmd, vertexCount, 1, 0, 0);
vkCmdEndQuery(cmd, pool, queryIdx);
```

> **스펙 발췌 (VUID-vkCmdBeginQuery-query-00802)** `query` 인덱스는 `queryPool`의 `queryCount`보다 작아야 한다.

> **스펙 발췌 (VUID-vkCmdBeginQuery-query-00808)** 렌더 패스 인스턴스 안에서 호출할 경우, `query` 인덱스와 현재 서브패스 view mask에 설정된 비트 수의 합이 `queryCount`를 초과해서는 안 된다.
>> 멀티뷰(Multiview) 환경에서는 활성화된 뷰 개수만큼 슬롯을 연속 소비하므로 인덱스 범위를 주의해야 한다.

> **스펙 발췌 (VUID-vkCmdBeginQuery-commandBuffer-01885)** `commandBuffer`는 protected 커맨드 버퍼가 아니어야 한다.

### 3.1. `VK_QUERY_CONTROL_PRECISE_BIT`

- 오클루전 쿼리에만 적용된다.
- `occlusionQueryPrecise` 기능이 필요하다.
- 비트를 켜면 GPU가 래스터화된 **정확한 샘플 수**를 계산한다. 비트를 끄면 불리언 가시성(0 또는 0 초과) 판정만 보장하는 **근사치**를 반환할 수 있다. 단순히 가시성 컬링 여부만 판단할 때는 비활성화하는 편이 성능상 유리하다.

> **스펙 발췌 (VUID-vkCmdBeginQuery-queryType-00800)** `occlusionQueryPrecise` 기능이 비활성화되었거나 쿼리 풀 타입이 `OCCLUSION`이 아닌 경우 `flags`에 `VK_QUERY_CONTROL_PRECISE_BIT`를 지정할 수 없다.

---

## 4. `vkCmdWriteTimestamp` — 단일 시점 기록

타임스탬프는 begin/end 없이 **특정 파이프라인 단계에 도달한 시점**을 즉시 기록한다.

```c
// 레거시 API: VkPipelineStageFlagBits 사용
vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, pool, 0);  // 시작 시점
// ... 렌더링 명령 ...
vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, pool, 1);  // 종료 시점

// Vulkan 1.3+ 동기화2(sync2): VkPipelineStageFlagBits2 사용
vkCmdWriteTimestamp2(cmd, VK_PIPELINE_STAGE_2_TOP_OF_PIPE_BIT, pool, 0);  // 시작 시점
// ... 렌더링 명령 ...
vkCmdWriteTimestamp2(cmd, VK_PIPELINE_STAGE_2_BOTTOM_OF_PIPE_BIT, pool, 1);  // 종료 시점
```

> **시그니처 안내** `void vkCmdWriteTimestamp2(VkCommandBuffer commandBuffer, VkPipelineStageFlags2 stage, VkQueryPool queryPool, uint32_t query)` — 별도 구조체를 넘기지 않고 64비트 스테이지 마스크를 직접 인자로 전달한다.

> **스펙 발췌 (VUID-vkCmdWriteTimestamp-pipelineStage-04075)** 타임스탬프 기록 스테이지에는 디바이스에서 활성화되지 않은 셰이더 단계(geometryShader, tessellationShader, meshShader 등)를 지정할 수 없다.

> **스펙 발췌 (VUID-vkCmdWriteTimestamp-timestampValidBits-00829)** 커맨드 풀이 속한 큐 패밀리의 `timestampValidBits`는 0보다 커야 한다.
>> 모든 큐가 타임스탬프를 지원하는 것은 아니므로 `VkQueueFamilyProperties::timestampValidBits`가 0인지 반드시 확인해야 한다.

### 4.1. 타임스탬프 값 환산

- 반환값은 나노초가 아닌 **GPU 내부 클럭 틱(tick)** 단위다.
- 동일한 물리 디바이스에서 측정한 타임스탬프끼리만 차이를 비교할 수 있다.
- 나노초 환산 공식: `elapsed_ns = (ts[1] - ts[0]) * timestampPeriod`
- `timestampPeriod`는 디바이스 구현에 따라 다르므로 반드시 `VkPhysicalDeviceProperties::limits.timestampPeriod`(틱당 나노초)로 조회해야 한다. 많은 외장 GPU에서 1.0(ns/tick)이지만, 특정 하드웨어나 모바일/통합 GPU에서는 다른 값이 반환되므로 고정값으로 단정해서는 안 된다.

```c
float period = props.limits.timestampPeriod;  // 틱당 나노초(ns)
uint64_t elapsed_ticks = ts[1] - ts[0];
double elapsed_ns = (double)elapsed_ticks * (double)period;
double elapsed_ms = elapsed_ns / 1e6;
```

---

## 5. `vkCmdResetQueryPool` — 풀 슬롯 초기화

```c
vkCmdResetQueryPool(cmd, pool, firstQuery, queryCount);
```

- 커맨드 버퍼에 기록되는 GPU 명령이며, 렌더 패스 인스턴스 **외부**에서만 호출할 수 있다(VUID-vkCmdResetQueryPool-renderpass). 활성 쿼리 구간 내에서는 리셋할 수 없다(VUID-vkCmdResetQueryPool-None-02841).
- `VK_QUERY_POOL_CREATE_RESET_BIT_KHR` 없이 생성한 풀의 각 슬롯은 **초기화되지 않은 상태**이므로, **첫 사용 전에 반드시 리셋해야 한다**(VUID-vkGetQueryPoolResults-None-09401).
- `RESET_BIT_KHR`로 생성한 풀은 첫 사용 전 명시적 리셋이 불필요하다.
- 이미 사용된 슬롯에 새 측정을 기록하려면 먼저 리셋해야 한다.

---

## 6. `vkGetQueryPoolResults` — CPU에서 결과 조회

```c
VkResult vkGetQueryPoolResults(
    VkDevice            device,
    VkQueryPool         queryPool,
    uint32_t            firstQuery,
    uint32_t            queryCount,
    size_t              dataSize,
    void*               pData,
    VkDeviceSize        stride,
    VkQueryResultFlags  flags);
```

### 6.1. `flags` 종류

| 플래그 | 설명 |
|--------|------|
| `64_BIT` | 결과를 64비트 부호 없는 정수(`uint64_t`)로 반환. 생략 시 32비트. |
| `WAIT_BIT` | 모든 쿼리 결과가 준비될 때까지 **호출한 CPU 스레드를 블로킹**. |
| `WITH_AVAILABILITY_BIT` | 각 쿼리 결과 뒤에 유효 여부(0 또는 1)를 추가 기록. |
| `PARTIAL_BIT` | 일부 쿼리만 완료되었더라도 준비된 결과를 반환. 생략 시 전체 완료 전까지 `VK_NOT_READY`. |
| `WITH_STATUS_BIT_KHR` | 비디오 쿼리의 상태 코드를 포함. 일반 쿼리에는 사용 불가. |

> **스펙 발췌 (VUID-vkGetQueryPoolResults-flags-00815)** `VK_QUERY_RESULT_64_BIT` 지정 시 `pData`는 8바이트 경계로 정렬되어야 한다.
> **(VUID-vkQueryPoolResults-queryCount-12252)** `queryCount > 1`이고 `64_BIT` 지정 시 `stride`는 8의 배수여야 한다.
> **(VUID-vkGetQueryPoolResults-stride-08993)** `queryCount > 1`이고 `WITH_AVAILABILITY_BIT` 지정 시 `stride`는 결과값 크기와 유효성 상태값을 모두 담을 만큼 커야 한다.

### 6.2. 반환값

| 반환값 | 상태 |
|--------|------|
| `VK_SUCCESS` | 요청한 모든 쿼리 결과를 정상적으로 수신 |
| `VK_NOT_READY` | `WAIT_BIT`를 쓰지 않았으며 일부 쿼리가 아직 준비되지 않음 |
| `VK_ERROR_*` | 디바이스 손실 등 런타임 오류 발생 |

### 6.3. 대표 활용 패턴

**GPU 타임스탬프 조회 (64비트 대기 모드):**

```c
uint64_t timestamps[2];
VkResult r = vkGetQueryPoolResults(device, pool, 0, 2,
    sizeof(timestamps), timestamps, sizeof(uint64_t),
    VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT);
if (r != VK_SUCCESS) { /* 오류 처리 */ }

float period = props.limits.timestampPeriod;
double elapsed_ms = (double)(timestamps[1] - timestamps[0]) * (double)period / 1e6;
```

**오클루전 쿼리 (가용 여부 폴링):**

```c
struct Result { uint32_t count; uint32_t available; } results[4];
vkGetQueryPoolResults(device, pool, 0, 4,
    sizeof(results), results, sizeof(Result),
    VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);
// available == 0이면 이전 프레임의 유효하지 않은 값이므로 사용하지 않음
```

**파이프라인 통계 조회:**

```c
struct Stats {
    uint64_t vs_invocations;
    uint64_t fs_invocations;
    uint64_t compute_invocations;
} stats;
vkGetQueryPoolResults(device, pool, 0, 1,
    sizeof(stats), &stats, sizeof(stats),
    VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT);
```

### 6.4. `vkCmdCopyQueryPoolResults` — 결과를 GPU 버퍼로 직접 복사

CPU를 거치지 않고 GPU 버퍼에 결과를 직접 기록하여 셰이더나 간접 드로우(Indirect draw) 인자로 전달할 때 사용한다.

```c
vkCmdCopyQueryPoolResults(cmd, pool, 0, queryCount,
    dstBuffer, dstOffset, stride,
    VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);
```

---

## 7. `PIPELINE_STATISTICS` 카운터 목록

`pipelineStatistics` 비트마스크로 수집할 통계 항목을 지정한다. 결과는 지정한 카운터 순서대로 배열에 저장되며, 각 값의 폭은 `vkGetQueryPoolResults` 호출 시 `VK_QUERY_RESULT_64_BIT` 플래그로 결정한다(미지정 시 32비트).

| 플래그 비트 | 측정 내용 | 요구 큐 |
|------------|----------|--------|
| `INPUT_ASSEMBLY_VERTICES_BIT` | 입력 어셈블리(IA)가 처리한 정점 수 | 그래픽스 |
| `INPUT_ASSEMBLY_PRIMITIVES_BIT` | 입력 어셈블리가 구성한 기본도형 수 | 그래픽스 |
| `VERTEX_SHADER_INVOCATIONS_BIT` | 버텍스 셰이더 실행 횟수 | 그래픽스 |
| `GEOMETRY_SHADER_INVOCATIONS_BIT` | 지오메트리 셰이더 실행 횟수 | 그래픽스 |
| `GEOMETRY_SHADER_PRIMITIVES_BIT` | 지오메트리 셰이더가 생성한 프리미티브 수 | 그래픽스 |
| `CLIPPING_INVOCATIONS_BIT` | 클리핑 단계 진입 프리미티브 수 | 그래픽스 |
| `CLIPPING_PRIMITIVES_BIT` | 클리핑 단계를 통과해 출력된 프리미티브 수 | 그래픽스 |
| `FRAGMENT_SHADER_INVOCATIONS_BIT` | 프래그먼트 셰이더 실행 횟수(헬퍼 픽셀 포함) | 그래픽스 |
| `TESSELLATION_CONTROL_SHADER_PATCHES_BIT` | 테셀레이션 제어 셰이더 패치 수 | 그래픽스 |
| `TESSELLATION_EVALUATION_SHADER_INVOCATIONS_BIT` | 테셀레이션 평가 셰이더 실행 횟수 | 그래픽스 |
| `COMPUTE_SHADER_INVOCATIONS_BIT` | 컴퓨트 셰이더 워크그룹 실행 횟수 | 컴퓨트 |
| `TASK_SHADER_INVOCATIONS_BIT_EXT` | 태스크 셰이더 워크그룹 실행 횟수 | 그래픽스 |
| `MESH_SHADER_INVOCATIONS_BIT_EXT` | 메쉬 셰이더 워크그룹 실행 횟수 | 그래픽스 |

> **스펙 발췌 (VUID-vkCmdBeginQuery-queryType-00804/00805)** 그래픽스 파이프라인 통계는 그래픽스 큐에서, 컴퓨트 통계는 컴퓨트 큐에서만 측정할 수 있다. 단일 쿼리 풀에서 두 성격을 혼용하여 측정할 수 없다.

---

## 8. `VK_KHR_performance_query`

하드웨어 제조사 전용 성능 카운터(GPU 클럭, 메모리 대역폭, L2 캐시 미스율 등)를 프로파일링할 때 사용한다. 하드웨어 의존적이므로 디바이스별 지원 목록을 사전에 질의해야 한다.

```c
VkQueryPoolPerformanceCreateInfoKHR pqci{};
pqci.sType = VK_STRUCTURE_TYPE_QUERY_POOL_PERFORMANCE_CREATE_INFO_KHR;
pqci.queueFamilyIndex = queueFamily;
pqci.counterIndexCount = 3;
pqci.pCounterIndices = (uint32_t[]){gpuClockId, l2MissesId, memReadsId};

VkQueryPoolCreateInfo qpci{};
qpci.sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO;
qpci.queryType = VK_QUERY_TYPE_PERFORMANCE_QUERY_KHR;
qpci.queryCount = 1;
qpci.pNext = &pqci;
vkCreateQueryPool(device, &qpci, nullptr, &pool);
```

결과는 `VkPerformanceCounterResultKHR` 공용체(`int32`, `int64`, `uint32`, `uint64`, `float32`, `float64`) 배열로 반환된다.

---

## 9. `vkCmdBeginQueryIndexedEXT` / `vkCmdEndQueryIndexedEXT`

`VK_EXT_transform_feedback`의 트랜스폼 피드백 스트림별 통계(`TRANSFORM_FEEDBACK_STREAM_EXT`, `PRIMITIVES_GENERATED_EXT`)를 집계할 때 사용한다.

```c
vkCmdBeginQueryIndexedEXT(cmd, pool, queryIdx, flags, index);
```

`index`는 **버텍스 스트림 인덱스**이며, `TRANSFORM_FEEDBACK_STREAM_EXT`/`PRIMITIVES_GENERATED_EXT` 외의 쿼리 타입에서는 반드시 0이어야 한다(VUID-vkCmdBeginQueryIndexedEXT-queryType-06692). 멀티뷰는 슬롯 연속 소비로 처리하므로 이 명령과 무관하다.

---

## 10. 실전 코드 — 프레임 GPU 소요 시간 측정

```c
// 1. 초기화 단계
VkQueryPoolCreateInfo qpci{};
qpci.sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO;
qpci.queryType = VK_QUERY_TYPE_TIMESTAMP;
qpci.queryCount = 2;  // 시작, 종료
vkCreateQueryPool(device, &qpci, nullptr, &timestampPool);

float timestampPeriod = props.limits.timestampPeriod;

// 2. 매 프레임 커맨드 기록
vkCmdResetQueryPool(cmd, timestampPool, 0, 2);
vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, timestampPool, 0);
// ... 프레임 렌더링 명령 ...
vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, timestampPool, 1);

// 3. 제출 및 동기화
vkQueueSubmit(queue, 1, &submit, frameFence);
vkWaitForFences(device, 1, &frameFence, VK_TRUE, UINT64_MAX);

// 4. 결과 읽기
uint64_t ts[2];
vkGetQueryPoolResults(device, timestampPool, 0, 2,
    sizeof(ts), ts, sizeof(uint64_t),
    VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT);

double frame_ms = (double)(ts[1] - ts[0]) * (double)timestampPeriod / 1e6;
```

---

## 11. 오클루전 활용 — 가시성 컬링

바운딩 박스를 렌더링하여 통과된 샘플 수를 기준으로 실제 메쉬의 렌더링 여부를 결정한다.

```c
// 바운딩 박스 오클루전 쿼리
vkCmdBeginQuery(cmd, occlusionPool, 0, 0);  // 근사치 측정(비트 미사용)
vkCmdBindVertexBuffers(cmd, 0, 1, &bboxVB, offsets);
vkCmdDraw(cmd, bboxVertexCount, 1, 0, 0);
vkCmdEndQuery(cmd, occlusionPool, 0);

// 제출 후 가시성 확인
uint32_t samplesPassed;
vkGetQueryPoolResults(device, occlusionPool, 0, 1,
    sizeof(samplesPassed), &samplesPassed, sizeof(uint32_t),
    VK_QUERY_RESULT_WAIT_BIT);

if (samplesPassed > 0) {
    // 화면에 최소 1픽셀 이상 노출되었으므로 실제 메쉬 렌더링 진행
}
```

---

## 12. 자주 발생하는 오류 점검 목록

### 12.1. 쿼리 풀 생성 단계

- [ ] `PIPELINE_STATISTICS` 타입을 쓰면서 `pipelineStatisticsQuery` 기능을 켜지 않음 (VUID-queryType-00791).
- [ ] `PIPELINE_STATISTICS` 풀인데 `pipelineStatistics` 비트마스크를 0으로 설정 (VUID-queryType-09534).
- [ ] `PERFORMANCE_QUERY_KHR` 풀 생성 시 pNext에 `VkQueryPoolPerformanceCreateInfoKHR` 누락 (VUID-queryType-03222).
- [ ] 메쉬 셰이더 카운터를 활성화하면서 `meshShaderQueries` 기능을 켜지 않음 (VUID-meshShaderQueries-07068).
- [ ] `queryCount = 0`으로 풀 생성 시도 (VUID-queryCount-02763).

### 12.2. Begin / End 단계

- [ ] 오클루전이나 파이프라인 통계 쿼리를 전송(Transfer) 전용 큐에서 호출 (VUID-queryType-00803).
- [ ] `occlusionQueryPrecise` 기능이 꺼진 상태에서 `VK_QUERY_CONTROL_PRECISE_BIT` 지정.
- [ ] 동일한 (풀, 슬롯) 조합에 중복 begin 호출 또는 짝이 맞지 않는 end 호출.
- [ ] 멀티뷰 렌더 패스에서 슬롯 인덱스와 뷰 마스크 비트 수의 합이 풀 크기를 초과 (VUID-query-00808).
- [ ] 보안(Protected) 커맨드 버퍼에서 쿼리 명령 기록 시도 (VUID-commandBuffer-01885).

### 12.3. WriteTimestamp 단계

- [ ] `timestampValidBits == 0`인 큐 패밀리에서 타임스탬프 기록 시도 (VUID-timestampValidBits-00829).
- [ ] 비활성화된 셰이더 파이프라인 단계를 stage 플래그에 지정 (VUID-pipelineStage-04075).
- [ ] 풀 타입이 `TIMESTAMP`가 아닌데 `vkCmdWriteTimestamp` 호출 (VUID-queryPool-01416).
- [ ] 이미 기록된 슬롯을 리셋하지 않고 재기록.
- [ ] GPU 작업 완료 동기화 없이 즉시 CPU에서 조회하여 `VK_NOT_READY`를 받거나 쓰레기값 참조.

### 12.4. GetQueryPoolResults 단계

- [ ] `64_BIT` 플래그 지정 시 버퍼 포인터의 8바이트 정렬 누락 (VUID-flags-00815).
- [ ] `queryCount > 1` 및 `64_BIT` 지정 시 `stride`가 8의 배수가 아님 (VUID-queryCount-12252).
- [ ] `WITH_AVAILABILITY_BIT` 지정 시 `stride`가 결과값 + 상태값 크기보다 작음 (VUID-stride-08993).
- [ ] `WAIT_BIT` 없이 결과를 읽으면서 반환값이 `VK_NOT_READY`인지 확인하지 않음.
- [ ] 타임스탬프 차이값에 `timestampPeriod`를 곱하지 않고 그대로 시간으로 간주.
- [ ] 서로 다른 디바이스에서 기록한 타임스탬프 값을 직접 감산 비교.

### 12.5. 구조 및 성능

- [ ] 매 프레임 쿼리 풀을 생성하고 파괴하는 오버헤드 유발 (사전 할당 후 재사용 권장).
- [ ] CPU에서 `WAIT_BIT`를 남발하여 메인 스레드 렌더링 파이프라인이 정체되는 현상.
- [ ] `VK_QUERY_POOL_CREATE_RESET_BIT_KHR` 없이 슬롯 초기화 커맨드를 누락하여 밸리데이션 에러 발생.
- [ ] 한 커맨드 버퍼에서 begin을 호출하고 다른 커맨드 버퍼에서 end를 호출 (동일 커맨드 버퍼 완결 원칙 위반).
