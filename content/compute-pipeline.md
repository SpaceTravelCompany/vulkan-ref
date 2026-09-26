---
title: 컴퓨트 파이프라인
slug: compute-pipeline
---

## 소개

Vulkan의 컴퓨트 파이프라인(`VkComputePipeline`)은 그래픽스 파이프라인에 비해 구조가 단순하다. 래스터화, 프레임버퍼, 블렌딩과 같은 고정 함수 단계가 없으며, **단일 컴퓨트 셰이더 스테이지**와 **파이프라인 레이아웃**만으로 구성된다.

### 주요 용어
- **Compute Shader**: 범용 병렬 연산(GPGPU)을 수행하는 프로그래머블 셰이더
- **Workgroup**: 로컬 스레드들의 실행 묶음. 동일 워크그룹 내부에서는 온칩 공유 메모리(`shared`)와 실행 배리어(`barrier()`)로 데이터를 교환하고 동기화할 수 있다.
- **Invocation**: 컴퓨트 셰이더 코드를 실행하는 단일 스레드 단위
- **Dispatch**: GPU에 워크그룹 그리드를 발행하는 커맨드 실행 명령

---

## 1. 그래픽스 파이프라인과의 차이점

| 항목 | 그래픽스 파이프라인 | 컴퓨트 파이프라인 |
|------|-------------------|-----------------|
| **셰이더 스테이지** | VS, FS (+ TCS, TES, GS, Task, Mesh) | **CS 단일 스테이지** |
| **고정 함수 유닛** | Vertex Input, Rasterizer, Depth/Stencil, Blend 등 | **없음** |
| **렌더 패스 / 프레임버퍼** | 필수 | **불필요** |
| **주요 입력** | 정점 버퍼, 인덱스 버퍼, Push Constant, Descriptor | Push Constant, Descriptor (SSBO, UBO, 텍스처 등) |
| **주요 출력** | Color Attachment, Depth/Stencil Buffer | Storage Buffer, Storage Image (UAV) |
| **실행 커맨드** | `vkCmdDraw*` | `vkCmdDispatch*` |
| **실행 계층** | 정점 → 프리미티브 → 프래그먼트 | **Workgroup 그리드 → Invocation** |

---

## 2. `VkComputePipelineCreateInfo` 구조체

```c
typedef struct VkComputePipelineCreateInfo {
    VkStructureType                    sType;
    const void*                        pNext;
    VkPipelineCreateFlags              flags;
    VkPipelineShaderStageCreateInfo    stage; // 단일 스테이지 구조체
    VkPipelineLayout                   layout;
    VkPipeline                         basePipelineHandle;
    int32_t                            basePipelineIndex;
} VkComputePipelineCreateInfo;
```

컴퓨트 파이프라인은 여러 스테이지를 배열로 받지 않고 `VkPipelineShaderStageCreateInfo` 단일 멤버를 직접 지정한다.

```c
VkComputePipelineCreateInfo compCI{};
compCI.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
compCI.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
compCI.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT; // 반드시 COMPUTE_BIT 지정
compCI.stage.module = computeShaderModule;
compCI.stage.pName = "main";
compCI.layout = pipelineLayout; // 디스크립터 세트 레이아웃 및 푸시 상수 정의

VkPipeline computePipeline;
vkCreateComputePipelines(device, pipelineCache, 1, &compCI, nullptr, &computePipeline);
```

### 유효성 검증 규칙
- `stage.stage`는 반드시 `VK_SHADER_STAGE_COMPUTE_BIT`여야 한다.
- `layout`은 셰이더가 접근하는 모든 디스크립터 세트와 푸시 상수 범위를 온전히 포함해야 한다.
- 파이프라인 라이브러리(`VK_PIPELINE_CREATE_LIBRARY_BIT_KHR`): 일반적인 파이프라인 라이브러리는 `VK_KHR_pipeline_library` 확장을 기반으로 하며, 컴퓨트 파이프라인에서 라이브러리 플래그를 사용하는 특수 경로(예: AMDX 디스패치 그래프)에서는 `shaderEnqueue` 기능이 활성화되어 있어야 한다(VUID-VkComputePipelineCreateInfo-shaderEnqueue-09177).
- `VK_PIPELINE_CREATE_INDIRECT_BINDABLE_BIT_NV`는 `deviceGeneratedComputePipelines` 피처가 활성화된 환경에서만 유효하다.
- 그래픽스 파이프라인 전용 플래그(메시 셰이더, 레이 트레이싱 등)는 컴퓨트 파이프라인 생성에 지정할 수 없다.

---

## 3. GLSL 컴퓨트 셰이더 기본 구조

컴퓨트 셰이더는 `main()` 함수가 발행된 모든 인보케이션(스레드)에서 병렬로 실행된다. 각 스레드는 고유한 내장 변수를 참조하여 자신이 처리할 데이터의 인덱스를 판별한다.

```glsl
#version 460 core
layout(local_size_x = 256, local_size_y = 1, local_size_z = 1) in;

// 입력 스토리지 버퍼
layout(set = 0, binding = 0) readonly buffer InputBuffer {
    float inData[];
};

// 출력 스토리지 버퍼
layout(set = 0, binding = 1) writeonly buffer OutputBuffer {
    float outData[];
};

// 푸시 상수
layout(push_constant) uniform PushConstants {
    uint numElements;
} pc;

void main() {
    uint idx = gl_GlobalInvocationID.x;
    if (idx < pc.numElements) {
        outData[idx] = inData[idx] * 2.0;
    }
}
```

### 주요 내장 변수
- `local_size_*`: 워크그룹 1개를 구성하는 3차원 인보케이션 개수
- `gl_GlobalInvocationID`: 전체 디스패치 그리드 내에서 현재 인보케이션의 고유 3차원 좌표  
  $$\text{gl\_GlobalInvocationID} = \text{gl\_WorkGroupID} \times \text{gl\_WorkGroupSize} + \text{gl\_LocalInvocationID}$$
- `gl_WorkGroupID`: 디스패치 그리드 내에서 현재 워크그룹의 3차원 인덱스
- `gl_LocalInvocationID`: 현재 워크그룹 내부에서 인보케이션의 3차원 인덱스
- `gl_LocalInvocationIndex`: 워크그룹 내 1차원 평탄화 인덱스 ($0 \le \text{index} < \text{local\_size\_x} \times \text{local\_size\_y} \times \text{local\_size\_z}$)
- `gl_NumWorkGroups`: `vkCmdDispatch`로 발행된 전체 워크그룹 개수

---

## 4. 디스패치 (실행)

> [!NOTE]
> `vkCmdDispatch` 및 `vkCmdDispatchIndirect`는 **렌더 패스 인스턴스 외부**에서만 호출할 수 있다. 렌더 패스 내부에서 컴퓨트 작업을 실행하려면 렌더 패스를 종료한 후 디스패치하거나, Dynamic Rendering 환경에서는 `vkCmdEndRendering` 이후에 호출해야 한다.

```c
// 파이프라인 바인딩
vkCmdBindPipeline(cmdBuffer, VK_PIPELINE_BIND_POINT_COMPUTE, computePipeline);

// 디스크립터 세트 바인딩
vkCmdBindDescriptorSets(cmdBuffer, VK_PIPELINE_BIND_POINT_COMPUTE,
    pipelineLayout, 0, 1, &descriptorSet, 0, nullptr);

// 푸시 상수 전달
vkCmdPushConstants(cmdBuffer, pipelineLayout,
    VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(uint32_t), &numElements);

// 디스패치 발행: (groupCountX, groupCountY, groupCountZ)
uint32_t groupCountX = (numElements + 255) / 256; // local_size_x = 256 기준 올림 계산
vkCmdDispatch(cmdBuffer, groupCountX, 1, 1);
```

총 실행되는 인보케이션 개수는 다음과 같다.
$$\text{Total Invocations} = (\text{groupCountX} \times \text{groupCountY} \times \text{groupCountZ}) \times (\text{local\_size\_x} \times \text{local\_size\_y} \times \text{local\_size\_z})$$

### 4.1. 디스패치 및 워크그룹 하드웨어 한계값

디바이스의 하드웨어 한계(`VkPhysicalDeviceLimits`)를 초과하여 디스패치하거나 워크그룹 크기를 선언하면 안 된다. 초과 시 스펙 위반이다(VUID-vkCmdDispatch-groupCountX-00386, groupCountY-00387, groupCountZ-00388).

| 한계값 프로퍼티 | 의미 | 일반적인 값 (데스크톱 dGPU) |
|----------------|------|---------------------------|
| `maxComputeWorkGroupCount[3]` | 디스패치 시 (X, Y, Z) 차원별 최대 워크그룹 수 | (65535, 65535, 65535) 또는 그 이상 |
| `maxComputeWorkGroupSize[3]` | `local_size_*`의 차원별 최대 인보케이션 수 | (1024, 1024, 64) |
| `maxComputeWorkGroupInvocations` | 워크그룹당 총 인보케이션 곱($\text{X} \times \text{Y} \times \text{Z}$)의 최대치 | 1024 |

---

## 5. Workgroup 구조 및 계층

GPU는 수많은 스레드를 대규모 병렬로 실행한다. 이들을 워크그룹 단위로 묶음으로써, 동일 그룹 내부에서 **온칩 공유 메모리**와 **실행 배리어 동기화**를 지원한다. 서로 다른 워크그룹은 완전히 독립적으로 스케줄링되며 실행 순서가 보장되지 않는다.

```flowchart
  A(["Dispatch (groupCount = 4,1,1)"])
  B["Workgroup (0,0,0) — 256 threads"]
  C["LocalInvocation 0 — GlobalID = (0,0,0)"]
  D["LocalInvocation 1 — GlobalID = (1,0,0)"]
  E["..."]
  F["LocalInvocation 255"]
  G["Workgroup (1,0,0) — 256 threads"]
  H["Workgroup (2,0,0) — 256 threads"]
  I["Workgroup (3,0,0) — 256 threads"]
  J["총 4 × 256 = 1024 invocations"]
  A --> B
  B --> C
  B --> D
  B --> E
  B --> F
  A --> G
  A --> H
  A --> I
  B & G & H & I --> J
```

동일 워크그룹 내 인보케이션 간에는 다음 기능을 활용할 수 있다.

| 기능 | 설명 |
|------|------|
| `shared` (온칩 로컬 메모리) | 워크그룹 전용 고속 공유 메모리. 코어 최소 보장값은 16384바이트(`maxComputeSharedMemorySize`), 실제 디바이스는 32~64KB를 지원하는 경우가 많음 |
| `barrier()` | 워크그룹 내 모든 인보케이션의 실행 흐름을 일치시키는 동기화 배리어 |
| `memoryBarrierShared()` | 공유 메모리 쓰기 작업의 가시성을 워크그룹 내에 보장 |
| `atomic*()` | 공유 메모리 또는 버퍼에 대한 원자적(Atomic) 읽기-수정-쓰기 연산 |

---

## 6. Shared Memory (공유 메모리)

전역 메모리(VRAM)는 대역폭과 레이턴시 비용이 높다. 동일 워크그룹의 스레드들이 인접 데이터를 반복적으로 참조할 때는 데이터를 온칩 공유 메모리에 올려두고 연산하면 성능을 크게 개선할 수 있다.

```glsl
layout(local_size_x = 256) in;

// 워크그룹 공유 메모리 선언
shared float tile[256];

void main() {
    uint lid = gl_LocalInvocationIndex;
    uint gid = gl_GlobalInvocationID.x;

    // 1. 전역 메모리에서 공유 메모리로 협력 로드
    tile[lid] = inData[gid];

    // 2. 워크그룹 내 모든 스레드의 로드가 완료될 때까지 대기
    barrier();

    // 3. 이웃 스레드가 로드한 데이터를 안전하게 참조 (컨볼루션 예시)
    float left  = (lid > 0) ? tile[lid - 1] : tile[lid];
    float right = (lid < 255) ? tile[lid + 1] : tile[lid];

    // 4. 연산 결과를 전역 메모리에 기록
    outData[gid] = (tile[lid] + left + right) / 3.0;
}
```

### 전형적인 공유 메모리 활용 패턴
- **리덕션(Reduction)**: 합계, 최댓값, 최솟값을 워크그룹 내에서 트리 형태로 축약
- **공간 필터링 / 컨볼루션**: 블러, 엣지 검출 등 주변 픽셀(Halo 영역)을 공유 메모리에 캐싱
- **접두사 합(Prefix Sum / Scan)**: 병렬 누적 합 연산
- **로컬 히스토그램**: 워크그룹 단위 로컬 카운터를 집계한 뒤 전역 버퍼에 병합

---

## 7. DispatchIndirect (간접 디스패치)

CPU 대신 GPU가 직접 워크그룹 수를 계산하여 디스패치하도록 만들려면 `vkCmdDispatchIndirect`를 사용한다.

```c
// VkDispatchIndirectCommand는 Vulkan 헤더에 이미 정의되어 있으므로 재정의하지 않는다.
// typedef struct VkDispatchIndirectCommand {
//     uint32_t x;  // groupCountX
//     uint32_t y;  // groupCountY
//     uint32_t z;  // groupCountZ
// } VkDispatchIndirectCommand;

// 간접 디스패치 실행 — 버퍼에 VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT 필수
vkCmdDispatchIndirect(cmdBuffer, indirectBuffer, offset);
```

### 주요 활용 사례
- **오클루전 컬링(Occlusion Culling)**: 가시성 검사 결과를 바탕으로 가시 메시렛 수를 계산해 후속 디스패치 그리드 크기 결정
- **가변 파티클 시뮬레이션**: 살아남은 파티클 개수에 맞추어 시뮬레이션 워크그룹 발행
- **GPU-Driven 렌더링 파이프라인**: CPU의 프레임별 개입 없이 GPU 내부 연산 결과만으로 다음 파이프라인 단계를 연속 트리거

---

## 8. 파이프라인 배리어와 동기화

컴퓨트 셰이더가 기록한 버퍼 데이터를 후속 작업(다른 컴퓨트 디스패치 또는 그래픽스 드로우)에서 안전하게 읽으려면 메모리 배리어가 필수적이다. 배리어를 누락하면 쓰기가 완료되기 전에 읽는 RAW(Read-After-Write) 데이터 레이스가 발생한다.

```c
// 컴퓨트 쓰기 완료 후 후속 컴퓨트 읽기로의 전환 배리어
VkMemoryBarrier barrier{};
barrier.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER;
barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT; // 컴퓨트 셰이더 쓰기
barrier.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;  // 다음 셰이더 읽기

vkCmdPipelineBarrier(
    cmdBuffer,
    VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, // src: 이전 컴퓨트 완료 대기
    VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, // dst: 다음 컴퓨트 시작 전 가시성 확보
    0,
    1, &barrier,                          // 메모리 배리어
    0, nullptr,
    0, nullptr
);
```

---

## 9. 컴퓨트 관련 유용한 확장 및 최신 기능

### 9.1. `VK_KHR_shader_float16_int8` (Vulkan 1.2 코어)
- 16비트 반정밀도 부동소수점(`float16_t`) 및 8비트 정수 연산을 지원한다. 머신러닝 추론이나 대규모 파티클 연산에서 메모리 대역폭을 절감하고 연산 처리량을 높인다.

### 9.2. 서브그룹(Subgroup) 연산
- 워크그룹보다 작은 하드웨어 실행 단위(NVIDIA 32 스레드 Warp, AMD 32/64 스레드 Wavefront)를 제어한다.
- 같은 서브그룹 내의 인보케이션들은 SIMD/SIMT 하드웨어 특성상 락스텝(lockstep)으로 실행되므로, 온칩 공유 메모리나 워크그룹 배리어 없이도 서브그룹 레벨 셔플, 밸럿(Ballot), 리덕션 연산을 매우 낮은 오버헤드로 수행할 수 있다.
- `subgroupBallot()`, `subgroupAdd()`, `subgroupShuffle()` 등은 Vulkan 1.1 코어(`VK_SUBGROUP_FEATURE_BALLOT/ARITHMETIC/SHUFFLE_BIT`)에서 지원한다. `VK_KHR_shader_subgroup_extended_types`(1.2 코어)는 이들 연산에 8/16비트 정수·16비트 부동소수점 **타입**을 추가로 허용하는 확장이다.
- 디바이스 지원 정보는 `VkPhysicalDeviceSubgroupProperties`를 통해 조회한다.

### 9.3. `VK_KHR_compute_shader_derivatives` (Vulkan 1.3 코어 지원 확장)
- 프래그먼트 셰이더 전용이었던 편미분 함수(`dFdx`, `dFdy`, `fwidth` 등)를 컴퓨트 셰이더의 $2 \times 2$ 쿼드 영역 내에서 호출할 수 있게 해 준다.

### 9.4. `VK_EXT_inline_uniform_block` (Vulkan 1.3 코어)
- 별도의 버퍼 할당 없이 디스크립터 세트 내부 메모리에 직접 작은 인라인 유니폼 데이터를 주입할 수 있다.

---

## 10. 실전 예제: 배열 요소 병렬 곱셈

```glsl
#version 460
layout(local_size_x = 256) in;

layout(set = 0, binding = 0) readonly buffer InputBuffer {
    float inData[];
};

layout(set = 0, binding = 1) writeonly buffer OutputBuffer {
    float outData[];
};

layout(push_constant) uniform Constants {
    uint count;
    float multiplier;
} pc;

void main() {
    uint idx = gl_GlobalInvocationID.x;
    if (idx < pc.count) {
        outData[idx] = inData[idx] * pc.multiplier;
    }
}
```

```c
// 호스트 애플리케이션 실행 코드
struct PushConstants {
    uint32_t count;
    float multiplier;
} pcData = { 1024, 2.5f };

vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, computePipeline);
vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipelineLayout,
    0, 1, &descriptorSet, 0, nullptr);
vkCmdPushConstants(cmd, pipelineLayout,
    VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(PushConstants), &pcData);

uint32_t workgroupCount = (pcData.count + 255) / 256;
vkCmdDispatch(cmd, workgroupCount, 1, 1);
```

---

## 11. 주요 적용 분야

| 분야 | 활용 방식 |
|------|-----------|
| **포스트 프로세싱** | 톤 매핑, 블룸(Bloom), 블러(Blur), 피사계 심도(DoF) |
| **파티클 시뮬레이션** | 대규모 파티클 위치, 속도 갱신, 물리 감쇠 연산 |
| **물리 엔진** | 강체 충돌 검사, 천(Cloth) 시뮬레이션, 유체(SPH) 계산 |
| **조명 및 렌더링** | 타일드/클러스터드 라이트 컬링, 복셀 기반 글로벌 일루미네이션(VXGI) |
| **캐릭터 애니메이션** | GPU 스키닝(Skinning), 블렌드 셰이프 모핑(Morph Target) |
| **GPU-Driven 렌더링** | GPU 절두체/오클루전 컬링, 인다이렉트 드로우 인자 생성 |
| **경량 ML/AI 추론** | 온디바이스 신경망 추론 연산 |
