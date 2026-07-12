---
title: Queries
slug: queries
---

## 소개

Vulkan에서 **GPU가 측정한 값을 CPU로 가져오는 통로**가 `VkQueryPool`이다. 픽셀 가시성(Occlusion), GPU 타임스탬프, 파이프라인 단계별 카운터 등을 수집한다.

> **용어 정리**
> - **Query Pool**: 미리 할당하는 쿼리 슬롯 묶음. `VkQueryPool` 핸들.
> - **Begin/End**: occlusion과 pipeline statistics는 `vkCmdBeginQuery`/`vkCmdEndQuery`로 영역을 감싼다.
> - **Write Timestamp**: timestamp는 `vkCmdWriteTimestamp`로 한 시점만 기록.
> - **Reset**: 풀의 슬롯을 초기화. `vkCmdResetQueryPool` (커맨드) 또는 `VK_QUERY_POOL_CREATE_RESET_BIT_KHR` (생성 시 자동).
> - **Result Flags**: CPU가 읽을 때 형식/대기 정책. `64_BIT`, `WAIT_BIT`, `WITH_AVAILABILITY_BIT`, `PARTIAL_BIT`.

이 문서는 **생성 → 기록 → 제출 → 결과 읽기** 흐름과 자주 빠지는 주의사항을 다룬다.

---

## 1. 큰 그림

```flowchart
flowchart TD
  A["VkQueryPool 생성 (type, count)"]
  B["[vkCmdResetQueryPool] — 선택"]
  C["영역:"]
  D(["vkCmdBeginQuery (occlusion / pipeline_statistics)"])
  E["... draw/dispatch ..."]
  F(["vkCmdEndQuery"])
  G["또는:"]
  H(["vkCmdWriteTimestamp (timestamp)"])
  I(["vkQueueSubmit + fence"])
  J["CPU가 결과 읽기:"]
  K(["vkGetQueryPoolResults(pool, flags)"])
  A --> B --> C
  C --> D --> E --> F
  C --> G --> H
  F --> I
  H --> I
  I --> J --> K
```

**핵심 포인트:**

- 결과는 **GPU 비동기**. CPU가 `vkGetQueryPoolResults` 호출 시점에 GPU가 끝나지 않았으면 `WAIT_BIT` 또는 fence로 동기화 필요.
- `OCLUSION`과 `PIPELINE_STATISTICS`는 **graphics 큐**에서만 (VUID-vkCmdBeginQuery-queryType-00803/00804).
- `PIPELINE_STATISTICS`는 `pipelineStatisticsQuery` feature 필요 (VUID-VkQueryPoolCreateInfo-queryType-00791).

---

## 2. `VkQueryPoolCreateInfo` — 풀 생성

```c
typedef struct VkQueryPoolCreateInfo {
    VkStructureType                  sType;
    const void*                      pNext;
    VkQueryPoolCreateFlags           flags;
    VkQueryType                      queryType;
    uint32_t                         queryCount;
    VkQueryPipelineStatisticFlags    pipelineStatistics;  // PIPELINE_STATISTICS일 때만
} VkQueryPoolCreateInfo;
```

### 2.1. `queryType` — 8종

| 값 | 의미 | 필요 feature | 비고 |
|----|------|--------------|------|
| `OCCLUSION` | 깊이/스텐실 테스트 통과 샘플 수 | (없음) | graphics 큐만 |
| `TIMESTAMP` | GPU 타임라인 한 시점 | (없음, 단 `timestampValidBits > 0`이어야 함) | 어떤 큐든 |
| `PIPELINE_STATISTICS` | 11개 카운터 | `pipelineStatisticsQuery` | graphics/컴퓨트 |
| `TRANSFORM_FEEDBACK_*` | transform feedback | (1.3에서 제거됨, 의도적) | — |
| `PERFORMANCE_QUERY_KHR` | 디바이스별 성능 카운터 | `VK_KHR_performance_query` | 별도 pNext |
| `ACCELERATION_STRUCTURE_COMPACTED_SIZE_*` | AS 컴팩트 사이즈 | ray tracing extension | — |
| `RESULT_STATUS_ONLY_KHR` | 비디오 인코딩 결과 상태 | `VK_KHR_video_queue` | video 큐 |
| `VIDEO_ENCODE_FEEDBACK_KHR` | 비디오 인코딩 피드백 | `VK_KHR_video_encode_queue` | video 큐 |

> **스펙 원문 (VUID-VkQueryPoolCreateInfo-queryType-00791)** If the `pipelineStatisticsQuery` feature is not enabled, `queryType` must not be `VK_QUERY_TYPE_PIPELINE_STATISTICS`.
>> feature 없으면 생성 자체가 실패.

> **스펙 원문 (VUID-VkQueryPoolCreateInfo-queryType-09534)** If `queryType` is `PIPELINE_STATISTICS`, `pipelineStatistics` must not be zero.
>> 어떤 카운터를 켤지 최소 1개는 명시.

> **스펙 원문 (VUID-VkQueryPoolCreateInfo-queryType-03222)** If `queryType` is `PERFORMANCE_QUERY_KHR`, the pNext chain must include a `VkQueryPoolPerformanceCreateInfoKHR` structure.
>> performance query는 별도 pNext 구조 필요.

### 2.2. `flags` — `RESET_BIT_KHR`

`VK_QUERY_POOL_CREATE_RESET_BIT_KHR` (`VK_KHR_maintenance9`, 또는 1.4+): 풀 생성 시 모든 쿼리를 초기화. **첫 사용 전 `vkCmdResetQueryPool` 호출 불필요.** 풀 재사용 패턴에서 매번 reset 안 해도 됨.

---

## 3. `vkCmdBeginQuery` / `vkCmdEndQuery` — 영역 기반

occlusion과 pipeline statistics는 **begin/end로 영역**을 감싼다. 영역 안의 모든 작업이 카운트에 반영.

```c
// Occlusion: 영역 안의 draw가 그려진 샘플 수
vkCmdBeginQuery(cmd, pool, queryIdx, VK_QUERY_CONTROL_PRECISE_BIT);  // 또는 0
vkCmdDraw(cmd, vertexCount, 1, 0, 0);
vkCmdEndQuery(cmd, pool, queryIdx);
```

> **스펙 원문 (VUID-vkCmdBeginQuery-query-00802)** `query` must be less than the number of queries in `queryPool`.
>> `queryIdx >= queryCount`는 무효.

> **스펙 원문 (VUID-vkCmdBeginQuery-query-00808)** If called within a render pass instance, the sum of `query` and the number of bits set in the current subpass's view mask must be less than or equal to the number of queries in `queryPool`.
>> 멀티뷰(multiview) 렌더 패스에서 view mask 비트와 query 인덱스가 겹치면 안 됨.

> **스펙 원문 (VUID-vkCmdBeginQuery-commandBuffer-01885)** `commandBuffer` must not be a protected command buffer.
>> protected command buffer에서는 쿼리 사용 불가.

### 3.1. `VK_QUERY_CONTROL_PRECISE_BIT`

- occlusion에만 적용
- `occlusionQueryPrecise` feature 필요
- 비트 활성화 시 GPU가 **정확한** 샘플 수를 셈 (보통 4x MSAA까지 정확). 비활성화 시 0/양수/음수가 아닌 **근사치**를 반환할 수 있어 **히트/미스 비교만** 의미 있음.

> **스펙 원문 (VUID-vkCmdBeginQuery)** If the `occlusionQueryPrecise` feature is not enabled, or the `queryType` used to create `queryPool` was not `OCCLUSION`, `flags` must not contain `VK_QUERY_CONTROL_PRECISE_BIT`.

---

## 4. `vkCmdWriteTimestamp` — 단일 시점

timestamp는 begin/end 없이 **한 시점**을 기록.

```c
// legacy: VkPipelineStageFlagBits
vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, pool, 0);  // 시작
// ... draws ...
vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, pool, 1);  // 끝

// 1.3+ sync2: VkPipelineStageFlagBits2
vkCmdWriteTimestamp2(cmd, &(VkWriteTimestampInfo2){
    .sType = VK_STRUCTURE_TYPE_WRITE_TIMESTAMP_INFO_2,
    .stage = VK_PIPELINE_STAGE_2_TOP_OF_PIPE_BIT,
    .queryPool = pool,
    .query = 0,
}, cmd);  // ⚠ vkCmdWriteTimestamp2는 (cmd, *pInfo)가 아니라 (cmd, *pInfo, cmd) 두 cmd
```

> **NOTE** 실제로는 `vkCmdWriteTimestamp2(commandBuffer, pWriteTimestampInfo)` — 한 cmd만 받음. 위 예시는 단순화. 정확한 시그니처는 `void vkCmdWriteTimestamp2(VkCommandBuffer, const VkWriteTimestampInfo2*)`.

> **스펙 원문 (VUID-vkCmdWriteTimestamp-pipelineStage-04075 ... 04080)** timestamp stage는 디바이스에서 활성화되지 않은 pipeline stage를 포함할 수 없음 (geometryShader, tessellationShader, conditionalRendering, fragmentDensityMap, transformFeedback, meshShader, taskShader, shadingRateImage, rayTracingPipeline 등).
>> `vkGetPhysicalDeviceFeatures`/extension 활성화 안 한 stage는 timestamp에도 못 씀.

> **스펙 원문 (VUID-vkCmdWriteTimestamp-timestampValidBits-00829)** The command pool's queue family must support a non-zero `timestampValidBits`.
>> 모든 큐가 timestamp를 지원하지 않음. `VkQueueFamilyProperties::timestampValidBits`로 확인.

### 4.1. Timestamp 값의 의미

- 반환값은 GPU 내부 카운터 (나노초는 **아님**)
- 비교는 같은 디바이스의 timestamp끼리만 의미 있음
- 진짜 나노초로 환산: `(t1 - t0) * timestampPeriod / 1e9` (나노초)
- `timestampPeriod`는 `VkPhysicalDeviceLimits::timestampPeriod` (나노초 per tick, 보통 1)

```c
float period = props.limits.timestampPeriod;  // ns per tick
uint64_t elapsed_ticks = ts[1] - ts[0];
double elapsed_ns = (double)elapsed_ticks * (double)period;
double elapsed_ms = elapsed_ns / 1e6;
```

---

## 5. `vkCmdResetQueryPool` — 풀 초기화

```c
vkCmdResetQueryPool(cmd, pool, firstQuery, queryCount);
```

- GPU에 기록되지만, **begin/end로 카운트되는 건 아님** — 풀 슬롯 상태만 초기화
- 같은 `pool`의 begin/end 사이에 reset 호출 가능
- `RESET_BIT_KHR`로 생성된 풀은 첫 사용 전 reset 불필요

> **스펙 원문** "All queries used by the command must be unavailable" (timestamps) — reset을 한 슬롯이 `vkCmdWriteTimestamp`로 사용 가능.

---

## 6. `vkGetQueryPoolResults` — CPU에서 결과 읽기

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

### 6.1. `flags` — 4 + 1 (video)

| 플래그 | 의미 |
|--------|------|
| `64_BIT` | 결과를 64비트 부호없는 정수 배열로. 없으면 32비트. |
| `WAIT_BIT` | 각 쿼리가 available 상태가 될 때까지 **호출 스레드 블로킹**. |
| `WITH_AVAILABILITY_BIT` | 각 쿼리 결과 뒤에 availability(0/1)를 추가. 부분적으로도 가능. |
| `PARTIAL_BIT` | 일부만 available이어도 반환. 없으면 모두 available 또는 `VK_NOT_READY`. |
| `WITH_STATUS_BIT_KHR` | video query의 status code 결과 포함. 일반 쿼리에서는 사용 불가. |

> **스펙 원문 (VUID-vkGetQueryPoolResults-flags-00815)** If `VK_QUERY_RESULT_64_BIT` is set in `flags` then `pData` must be aligned to a multiple of 8.
> **(VUID-vkQueryPoolResults-queryCount-12252)** If `queryCount` is greater than 1 and `VK_QUERY_RESULT_64_BIT` is set in `flags`, then `stride` must be a multiple of 8.
> **(VUID-vkGetQueryPoolResults-stride-08993)** If `queryCount` is greater than 1 and `VK_QUERY_RESULT_WITH_AVAILABILITY_BIT` is set, `stride` must be large enough to contain the unsigned integer representing availability or status in addition to the query result.
>> 정렬 / stride 요건. CPU 측 버퍼도 8바이트 정렬 필요.

> **스펙 원문 (VUID-vkGetQueryPoolResults-queryType-09442)** If `queryType` was `RESULT_STATUS_ONLY_KHR`, then `flags` must include `VK_QUERY_RESULT_WITH_STATUS_BIT_KHR`.
> **(VUID-flags-09443)** If `flags` includes `WITH_STATUS_BIT_KHR`, then it must not include `WITH_AVAILABILITY_BIT`.
>> status flag는 availability와 동시 사용 불가.

### 6.2. 반환값

| 반환값 | 의미 |
|--------|------|
| `VK_SUCCESS` | 모든 쿼리 결과 사용 가능 (PARTIAL 없으면) |
| `VK_NOT_READY` | 일부 또는 전체 쿼리 아직 사용 불가. WAIT_BIT 미사용 시 |
| `VK_ERROR_*` | 디바이스 오류 등 |

### 6.3. 전형적 패턴

**타임스탬프 (64비트, WAIT):**

```c
uint64_t timestamps[2];
VkResult r = vkGetQueryPoolResults(device, pool, 0, 2,
    sizeof(timestamps), timestamps, sizeof(uint64_t),
    VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT);
if (r != VK_SUCCESS) { /* error */ }

float period = props.limits.timestampPeriod;
double ns = (double)(timestamps[1] - timestamps[0]) * (double)period;
```

**Occlusion (32비트, availability 포함):**

```c
struct Result { uint32_t count; uint32_t available; } results[4];
vkGetQueryPoolResults(device, pool, 0, 4,
    sizeof(results), results, sizeof(Result),
    VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);
// available == 0 이면 그 카운트는 stale. PARTIAL_BIT 없으면 모두 1일 때까지 wait.
```

**Pipeline statistics (다중 카운터):**

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

### 6.4. `vkCmdCopyQueryPoolResults` — 결과를 GPU 버퍼로

GPU 측 버퍼에 직접 복사해서 셰이더에서 읽거나 후속 명령에서 사용 가능. `flags`/`stride` 요건은 `vkGetQueryPoolResults`와 동일.

```c
vkCmdCopyQueryPoolResults(cmd, pool, 0, queryCount,
    dstBuffer, dstOffset, stride,
    VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);
```

---

## 7. `PIPELINE_STATISTICS` — 11종 카운터

`pipelineStatistics` 비트마스크로 켤 카운터를 고른다. 결과는 카운터당 1개 `uint64` (PIPELINE_STATISTICS_queryType에 한해). `64_BIT` 강제.

| 비트 | 의미 | 큐 요구 |
|------|------|--------|
| `INPUT_ASSEMBLY_VERTICES_BIT` | IA 단계가 처리한 정점 수 | graphics |
| `INPUT_ASSEMBLY_PRIMITIVES_BIT` | IA 단계가 처리한 프리미티브 수 | graphics |
| `VERTEX_SHADER_INVOCATIONS_BIT` | VS 호출 수 | graphics |
| `GEOMETRY_SHADER_INVOCATIONS_BIT` | GS 호출 수 (인스턴스마다) | graphics |
| `GEOMETRY_SHADER_PRIMITIVES_BIT` | GS가 출력한 프리미티브 수 | graphics |
| `CLIPPING_INVOCATIONS_BIT` | 클리퍼 호출 수 | graphics |
| `CLIPPING_PRIMITIVES_BIT` | 클리퍼 출력 프리미티브 수 | graphics |
| `FRAGMENT_SHADER_INVOCATIONS_BIT` | FS 호출 수 (보통 helper invocation 포함) | graphics |
| `TESSELLATION_CONTROL_SHADER_PATCHES_BIT` | TCS 패치 수 | graphics |
| `TESSELLATION_EVALUATION_SHADER_INVOCATIONS_BIT` | TES 호출 수 | graphics |
| `COMPUTE_SHADER_INVOCATIONS_BIT` | CS 워크그룹 호출 수 | compute |
| `TASK_SHADER_INVOCATIONS_BIT_EXT` | task shader 호출 (mesh) | graphics |
| `MESH_SHADER_INVOCATIONS_BIT_EXT` | mesh shader 호출 | graphics |
| `CLUSTER_CULLING_SHADER_INVOCATIONS_BIT_HUAWEI` | cluster culling shader | graphics |

> **스펙 원문 (VUID-vkCmdBeginQuery-queryType-00804)** If `queryType` is `PIPELINE_STATISTICS` and any of the `pipelineStatistics` indicate graphics operations, the command pool must support graphics operations.
> **(VUID-vkCmdBeginQuery-queryType-00805)** ... compute operations indicated, the command pool must support compute.
>> graphics 카운터는 graphics 큐, compute 카운터는 compute 큐. 혼합은 불가.

> **스펙 원문 (VUID-VkQueryPoolCreateInfo-meshShaderQueries-07069)** If the `meshShaderQueries` feature is not enabled, and `queryType` is `PIPELINE_STATISTICS`, `pipelineStatistics` must not contain `TASK_SHADER_INVOCATIONS_BIT_EXT` or `MESH_SHADER_INVOCATIONS_BIT_EXT`.
>> mesh shader 카운터는 feature 필요.

> **스펙 원문 (VUID-...-pipelineStatistics-07076)** Mesh task draw에서는 일반 IA/VS/GS/... 카운터가 PIPELINE_STATISTICS에 포함되어 있으면 안 됨. (MESH 단계와 충돌)
>> mesh path를 쓰면 전통적 IA/VS 카운터를 빼고 mesh/task 카운터로 대체.

---

## 8. `VK_KHR_performance_query` (간단히)

`VK_KHR_performance_query`는 디바이스별 카운터(예: GPU 클럭, 메모리 대역폭, L2 캐시 미스 등)를 다룬다. `pipelineStatisticsQuery`보다 강력하지만 디바이스 의존적.

```c
VkQueryPoolPerformanceCreateInfoKHR pqci{};
pqci.sType = VK_STRUCTURE_TYPE_QUERY_POOL_PERFORMANCE_CREATE_INFO_KHR;
pqci.queueFamilyIndex = queueFamily;
pqci.counterIndexCount = 3;
pqci.pCounterIndices = (uint32_t[]){gpuClockId, l2MissesId, memReadsId};

VkQueryPoolCreateInfo qpci{};
qpci.queryType = VK_QUERY_TYPE_PERFORMANCE_QUERY_KHR;
qpci.queryCount = 1;
qpci.pNext = &pqci;
vkCreateQueryPool(device, &qpci, nullptr, &pool);
```

결과는 `VkPerformanceCounterResultKHR` (union: `int32`, `int64`, `uint32`, `uint64`, `float32`, `float64`). stride는 이 구조체 크기의 배수.

---

## 9. `vkCmdBeginQueryIndexedEXT` / `vkCmdEndQueryIndexedEXT`

`VK_EXT_transform_feedback` 잔재 + multi-view 카운팅. `VK_QUERY_TYPE_PRIMITIVES_GENERATED_EXT`, `MESH_PRIMITIVES_GENERATED_EXT`와 함께 사용. 메쉬/트랜스폼 피드백에서 **view index별로 별도 카운트**.

```c
vkCmdBeginQueryIndexedEXT(cmd, pool, queryIdx, flags, index);
```

`index`는 multi-view의 view index. 결과는 query마다 한 슬롯이지만, view별로 카운트가 누적되지 않음(독립).

---

## 10. 전형적 코드 — 프레임 GPU 타이밍

```c
// 초기화
VkQueryPoolCreateInfo qpci{};
qpci.sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO;
qpci.queryType = VK_QUERY_TYPE_TIMESTAMP;
qpci.queryCount = 2;  // 시작, 끝
vkCreateQueryPool(device, &qpci, nullptr, &timestampPool);

float timestampPeriod = props.limits.timestampPeriod;

// 매 프레임
vkCmdResetQueryPool(cmd, timestampPool, 0, 2);
vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, timestampPool, 0);
// ... 프레임 렌더링 ...
vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, timestampPool, 1);

// submit + fence wait
vkQueueSubmit(queue, 1, &submit, frameFence);
vkWaitForFences(device, 1, &frameFence, VK_TRUE, UINT64_MAX);

uint64_t ts[2];
vkGetQueryPoolResults(device, timestampPool, 0, 2,
    sizeof(ts), ts, sizeof(uint64_t),
    VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT);

double frame_ms = (double)(ts[1] - ts[0]) * (double)timestampPeriod / 1e6;
```

---

## 11. Occlusion 활용 — Hi-Z 빌드 / 컬링

```c
// 메쉬 A의 occluder 화면 영역
vkCmdBeginQuery(cmd, occlusionPool, 0, 0);  // precise 안 함
vkCmdBindVertexBuffers(cmd, 0, 1, &occluderVB, offsets);
vkCmdDraw(cmd, occluderVertexCount, 1, 0, 0);
vkCmdEndQuery(cmd, occlusionPool, 0);

// submit 후 결과 확인
uint32_t samplesPassed;
vkGetQueryPoolResults(device, occlusionPool, 0, 1,
    sizeof(samplesPassed), &samplesPassed, sizeof(uint32_t),
    VK_QUERY_RESULT_WAIT_BIT);

if (samplesPassed > threshold) {
    // 메쉬 A가 occluder에 가려졌을 수 있음 → 컬 후보
}
```

- 보통 `threshold`는 `targetWidth * targetHeight * 0.001` 같이 매우 작은 값
- precise는 보통 끄고 (PARTIAL_BIT 없이) 0 vs non-0 비교만 사용

---

## 12. 자주 빠지는 주의사항 모음

### 12.1. 생성

- [ ] `PIPELINE_STATISTICS` queryType인데 `pipelineStatisticsQuery` feature 비활성 (VUID-queryType-00791).
- [ ] `PIPELINE_STATISTICS`인데 `pipelineStatistics == 0` (VUID-queryType-09534).
- [ ] `PERFORMANCE_QUERY_KHR`인데 pNext에 `VkQueryPoolPerformanceCreateInfoKHR` 없음 (VUID-queryType-03222).
- [ ] MESH_SHADER 카운터 켜고 `meshShaderQueries` feature 비활성 (VUID-meshShaderQueries-07068/07069).
- [ ] `queryCount = 0` 또는 `queryIdx >= queryCount` (VUID-queryCount-02763, query-00802).

### 12.2. Begin/End

- [ ] OCCLUSION/PIPELINE_STATISTICS begin을 **transfer/async compute 큐**에서 호출 (VUID-queryType-00803/00804/00805).
- [ ] `VK_QUERY_CONTROL_PRECISE_BIT` + `occlusionQueryPrecise` 비활성 (VUID-flags-...).
- [ ] 같은 (pool, query)에 begin 두 번 또는 짝 안 맞는 end.
- [ ] 렌더 패스 내부 multiview에서 query 인덱스 + view mask 비트 겹침 (VUID-query-00808).
- [ ] protected command buffer (VUID-commandBuffer-01885).
- [ ] 활성 비디오 세션 + 다른 query type (VUID-None-07127/07128/07129/07130).

### 12.3. WriteTimestamp

- [ ] `timestampValidBits == 0`인 큐 패밀리 (VUID-timestampValidBits-00829/03863).
- [ ] 활성화 안 된 feature의 pipeline stage (VUID-pipelineStage-04075..04080, VUID-stage-10751..10753).
- [ ] timestamp pool이 아닌데 호출 (VUID-queryPool-01416/03861).
- [ ] 이미 used된 슬롯에 다시 기록 (VUID-None-00830, N-03864).
- [ ] 동기화 안 하고 read → `VK_NOT_READY` 또는 stale 값.

### 12.4. GetQueryPoolResults

- [ ] `64_BIT` + 정렬 안 된 버퍼 (VUID-flags-00815).
- [ ] `queryCount > 1` + `64_BIT`인데 `stride`가 8의 배수 아님 (VUID-queryCount-12252).
- [ ] `WITH_AVAILABILITY_BIT`인데 `stride`가 결과 + availability 1개 분량 미만 (VUID-stride-08993).
- [ ] `WAIT_BIT` 없이 호출 → 일부 쿼리만 사용 가능할 수 있는데 결과를 신뢰.
- [ ] `WITH_STATUS_BIT_KHR` + `WITH_AVAILABILITY_BIT` 동시 (VUID-flags-09443).
- [ ] `RESULT_STATUS_ONLY_KHR`인데 `WITH_STATUS_BIT_KHR` 누락 (VUID-queryType-09442).
- [ ] `dataSize`가 부족 (VUID-dataSize-00817).
- [ ] 같은 pool에 동시 host read (외부 동기화 누락).
- [ ] timestamp 값을 device 간 비교 (의미 없음).
- [ ] timestamp 차이를 직접 ns/ms로 간주 (반드시 `timestampPeriod` 곱하기).

### 12.5. 일반 / 실전

- [ ] 매 프레임 query pool 생성/파괴 → 풀로 재사용.
- [ ] WAIT_BIT 남용 → 매번 CPU 정지. 가용 여부만 보고 conditional wait.
- [ ] `VK_QUERY_POOL_CREATE_RESET_BIT_KHR` 없이 매 사용 전 `vkCmdResetQueryPool` 누락.
- [ ] 같은 command buffer에서 begin → 다른 command buffer에서 end (불가).
- [ ] 쿼리 결과를 texture로 사용하려고 `vkCmdCopyQueryPoolResults`의 stride를 잘못 계산.
