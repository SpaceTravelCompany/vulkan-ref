---
title: 컴퓨트 파이프라인
slug: compute-pipeline
---

## 소개

Vulkan의 컴퓨트 파이프라인(VkComputePipeline)은 그래픽스 파이프라인보다 훨씬 간단하다. **단일 컴퓨트 셰이더 스테이지**와 **파이프라인 레이아웃**만 있으면 된다. 고정 함수 유닛(래스터화, 블렌딩 등)은 전혀 존재하지 않는다.

> **용어 정리**
> - **Compute Shader**: GPU에서 실행되는 병렬 계산 프로그램
> - **Workgroup**: 스레드의 묶음. 같은 workgroup 안에서는 데이터 공유가 가능하다
> - **Invocation**: 컴퓨트 셰이더의 단일 실행 단위 (= 한 스레드)
> - **Dispatch**: 컴퓨트 작업을 GPU에 제출하는 명령

---

## 1. 그래픽스 파이프라인과의 차이

| 항목 | Graphics Pipeline | Compute Pipeline |
|------|-----------------|-----------------|
| 셰이더 | VS + FS (+ TCS/TES/GS/Task/Mesh) | **CS 하나** (단일 스테이지) |
| 고정 함수 | VertexInput, IA, Raster, MS, DS, CB 등 | **없음** |
| Render Pass | 필요 | 불필요 |
| Framebuffer | 필요 | 불필요 |
| 입력 | 버텍스 버퍼 / 인덱스 버퍼 / Push Constant / Descriptor | Push Constant / Descriptor |
| 출력 | Color Attachment / DepthStencil | Storage Buffer / Storage Image (UAV) |
| 호출 방식 | `vkCmdDraw*` | `vkCmdDispatch*` |
| 실행 단위 | 정점 → 프리미티브 → 프래그먼트 | **Workgroup → Invocation** |

---

## 2. `VkComputePipelineCreateInfo` 구조체

```c
typedef struct VkComputePipelineCreateInfo {
    VkStructureType                    sType;
    const void*                        pNext;
    VkPipelineCreateFlags              flags;
    VkPipelineShaderStageCreateInfo    stage;          // 하나만!
    VkPipelineLayout                   layout;
    VkPipeline                         basePipelineHandle;
    int32_t                            basePipelineIndex;
} VkComputePipelineCreateInfo;
```

스펙(10.3. Compute Pipelines)의 설명:

> Compute pipelines consist of a single static compute shader stage and the pipeline layout.

그래픽스 파이프라인과 달리 `VkPipelineShaderStageCreateInfo`를 배열로 받지 않고 **단일 구조체**로 받는다.

```c
VkComputePipelineCreateInfo compCI{};
compCI.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
compCI.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
compCI.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT; // 필수!
compCI.stage.module = computeShaderModule;
compCI.stage.pName = "main";
compCI.layout = pipelineLayout; // Descriptor Set Layout + Push Constant 포함

VkPipeline computePipeline;
vkCreateComputePipelines(device, VK_NULL_HANDLE, 1, &compCI, nullptr, &computePipeline);
```

**유효성 규칙:**
- `stage.stage`는 반드시 `VK_SHADER_STAGE_COMPUTE_BIT`여야 함
- `layout`의 `VkPipelineLayout`은 셰이더가 사용하는 모든 descriptor / push constant를 포함해야 함
- `VK_PIPELINE_CREATE_LIBRARY_BIT_KHR`는 `shaderMeshEnqueue` feature 필요
- `VK_PIPELINE_CREATE_INDIRECT_BINDABLE_BIT_NV`로 Device-Generated Commands 지원
- 메시 셰이더나 레이 트레이싱 관련 flag는 전부 금지

---

## 3. GLSL 컴퓨트 셰이더 기본 구조

컴퓨트 셰이더는 그래픽스 셰이더와 달리 `main()`이 **각 스레드마다 실행**된다.

> **비유**: 공장 컨베이어 벨트. 각 작업자(스레드)가 자기 물건(데이터)만 처리하면 된다. 전체 작업량은 `dispatch`로 지정하고, 각 작업자는 `gl_GlobalInvocationID`로 "내가 몇 번째 물건 담당인지"를 안다.

```glsl
#version 460 core
layout(local_size_x = 256, local_size_y = 1, local_size_z = 1) in;

// Descriptor: Storage Buffer
layout(set = 0, binding = 0) buffer InputBuffer {
    float data[];
} inputBuf;

layout(set = 0, binding = 1) buffer OutputBuffer {
    float data[];
} outputBuf;

// Push Constant
layout(push_constant) uniform PushConstants {
    int numElements;
} pc;

void main() {
    uint idx = gl_GlobalInvocationID.x;
    if (idx < pc.numElements) {
        outputBuf.data[idx] = inputBuf.data[idx] * 2.0;
    }
}
```

**핵심 키워드:**
- `local_size_*`: workgroup 크기 (스레드/워크그룹)
- `gl_GlobalInvocationID.x` = `gl_WorkGroupID.x * gl_WorkGroupSize.x + gl_LocalInvocationID.x`
- `gl_NumWorkGroups`: dispatch에 전달된 전체 workgroup 수
- `gl_LocalInvocationIndex`: workgroup 내 1차원 인덱스

---

## 4. Dispatch (실행)

```c
// 파이프라인 바인딩
vkCmdBindPipeline(cmdBuffer, VK_PIPELINE_BIND_POINT_COMPUTE, computePipeline);

// Descriptor Set 바인딩
vkCmdBindDescriptorSets(cmdBuffer, VK_PIPELINE_BIND_POINT_COMPUTE,
    pipelineLayout, 0, 1, &descriptorSet, 0, nullptr);

// Push Constant 전송
vkCmdPushConstants(cmdBuffer, pipelineLayout,
    VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(int), &numElements);

// Dispatch: (groupCountX, groupCountY, groupCountZ)
int groupCountX = (numElements + 255) / 256; // local_size_x = 256 기준
vkCmdDispatch(cmdBuffer, groupCountX, 1, 1);
```

총 실행되는 invocation 수:
```
groupCountX × groupCountY × groupCountZ × local_size_x × local_size_y × local_size_z
```

예: `vkCmdDispatch(4, 1, 1)` + `local_size_x = 256` = 1024 invocations

---

## 5. Workgroup 구조

컴퓨트 셰이더의 실행 단계를 이해하는 것이 중요하다.

> **왜 workgroup으로 나눌까?** GPU는 수천 개의 스레드를 동시에 실행한다. 이들을 하나의 그룹으로 묶으면, 그룹 내에서 **공유 메모리**나 **배리어 동기화**를 사용할 수 있다. 반대로 다른 그룹끼리는 완전히 독립적으로 실행된다.

```flowchart
flowchart TD
  A(["Dispatch"])
  B["Workgroup (0,0,0) — 256 threads"]
  C["LocalInvocation 0 — gl_GlobalInvocationID = (0,0,0)"]
  D["LocalInvocation 1 — gl_GlobalInvocationID = (1,0,0)"]
  E["..."]
  F["LocalInvocation 255"]
  G["Workgroup (1,0,0) — 256 threads"]
  H["..."]
  I["Workgroup (2,0,0)"]
  J["Workgroup (3,0,0)"]
  K["총 4 × 256 = 1024 invocations"]
  A --> B
  B --> C
  B --> D
  B --> E
  B --> F
  B --> G
  G --> H
  H --> I
  I --> J
  J --> K
```

**각 invocation은 독립적으로 실행**되지만, 같은 workgroup 안에서는 다음이 가능:

| 기능 | 설명 |
|------|------|
| `shared` (Local Memory) | 워크그룹 내 공유 메모리 (~32-48KB, 하드웨어 의존) |
| `barrier()` | 워크그룹 내 모든 invocation의 실행 동기화 |
| `atomic*()` | shared memory 또는 buffer에 대한 원자 연산 |
| `gl_LocalInvocationID` | workgroup 내 인덱스 (0 ~ local_size-1) |
| `gl_WorkGroupID` | dispatch 내 workgroup 인덱스 |

---

## 6. Shared Memory (Workgroup Local Memory)

같은 워크그룹 내에서 invocation끼리 데이터를 공유할 때 사용한다.

> **용도** 전역 메모리(GPU VRAM)는 느리다. 같은 workgroup 스레드들이 같은 데이터를 반복 접근한다면, on-chip 공유 메모리에 복사해두면 훨씬 빠르다. L1 캐시와 비슷한 역할이라고 생각하면 된다.

> **주의**: 공유 메모리는 하드웨어마다 크기가 다르다 (보통 32~48KB). 너무 많이 쓰면 워크그룹 크기를 줄여야 할 수도 있다.

```glsl
layout(local_size_x = 256) in;

// Workgroup shared memory
shared float tile[256];

void main() {
    uint idx = gl_LocalInvocationIndex;

    // 1. 전역 메모리에서 shared로 로드
    tile[idx] = inputBuf.data[gl_GlobalInvocationID.x];

    // 2. 모든 invocation이 로드를 끝낼 때까지 기다림
    barrier();

    // 3. 이제 이웃 invocation의 데이터를 읽을 수 있음
    float left  = tile[(idx > 0) ? idx - 1 : idx];
    float right = tile[(idx < 255) ? idx + 1 : idx];

    // 4. 병합 후 전역 메모리에 쓰기
    outputBuf.data[gl_GlobalInvocationID.x] = (tile[idx] + left + right) / 3.0;
}
```

**Shared Memory를 활용하는 전형적인 패턴:**

| 패턴 | 예시 |
|------|------|
 | Reduction | 합계/최대값 구하기 (병렬 반으로 줄이기) |
| Stencil / Convolution | 주변 픽셀 읽기 (tile + halo) |
| Prefix Sum (Scan) | 병렬 누적 합 |
| Histogram | 워크그룹별 local histogram → 글로벌 병합 |

---

## 7. DispatchIndirect (간접 디스패치)

GPU가 직접 workgroup 수를 결정하게 하려면 `vkCmdDispatchIndirect`를 사용한다.

> **언제 쓰나?** 예를 들어 가시성 테스트(occlusion culling) 결과에 따라 렌더링할 객체 수가 달라질 때. 컴퓨트 셰이더가 "몇 개를 그릴지" 계산해서 indirect buffer에 쓰고, 그걸 기반으로 다시 dispatch한다. GPU-Driven 렌더링의 핵심 기법이다.

```c
// Indirect dispatch buffer (GPU가 채움)
VkBuffer indirectBuffer; // VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT

// CPU에서 직접 채울 수도 있음
struct DispatchIndirectCommand {
    uint32_t x; // groupCountX
    uint32_t y; // groupCountY
    uint32_t z; // groupCountZ
} cmd = { 4, 1, 1 };
// indirectBuffer에 쓰기

// 간접 디스패치
vkCmdDispatchIndirect(cmdBuffer, indirectBuffer, offset);
```

활용 예:
- Compute shader가 workgroup 수를 계산해서 `indirectBuffer`에 씀
- Visibility buffer 기반 간접 디스패치
- GPU-Driven 파이프라인 (GPU가 다음 dispatch의 크기를 결정)

---

## 8. Pipeline Barrier와 Compute

컴퓨트 파이프라인도 동기화가 필요하다. 기본적으로 `VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT`와 `VK_ACCESS_SHADER_WRITE_BIT` / `VK_ACCESS_SHADER_READ_BIT`를 사용한다.

> **용도** 컴퓨트 셰이더가 buffer에 데이터를 썼는데, 바로 다음 셰이더가 그걸 읽으려고 한다. GPU가 병렬로 실행하다 보면 "아직 쓰기 전인데 읽는" 상황이 생길 수 있다. Barrier로 "쓰기가 끝날 때까지 기다려"라고 명시해야 한다.

```c
// 컴퓨트 dispatch → 이후 다른 dispatch 또는 그래픽스에서 읽기
VkMemoryBarrier barrier{};
barrier.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER;
barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
barrier.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;

vkCmdPipelineBarrier(cmdBuffer,
    VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,    // src: 컴퓨트 쓰기 완료
    VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,    // dst: 다음 컴퓨트 읽기
    0,
    1, &barrier,                              // memory barrier
    0, nullptr,
    0, nullptr);
```

---

## 9. 컴퓨트에 유용한 확장 기능들

### 9.1. `VK_KHR_shader_float16_int8` (Vulkan 1.2)
- FP16 / INT8 데이터 타입 지원. AI/ML 워크로드에서 성능 향상.

### 9.2. `VK_KHR_shader_subgroup_extended_types` (Vulkan 1.2)
- 셰이더에서 subgroup ballot, shuffle, broadcast 등 활용. workgroup 내보다 더 작은 단위의 동기화.

### 9.3. `VK_KHR_compute_shader_derivatives`
- 컴퓨트 셰이더에서 `dFdx` / `dFdy` 등 그래픽스 전용 함수 사용 가능.

### 9.4. `VK_EXT_inline_uniform_block` (Vulkan 1.3 core 승격)
- 인라인 유니폼 블록: 작은 상수 데이터를 별도 버퍼 없이 전달.

### 9.5. Pipeline Binary / Pipeline Cache
- 그래픽스 파이프라인과 마찬가지로, `VkPipelineCache`로 컴퓨트 파이프라인 컴파일 결과도 캐싱 가능.

```c
vkCreateComputePipelines(device, pipelineCache, 1, &compCI, nullptr, &pipeline);
```

---

## 10. 실전 예제: Float 배열 병렬 곱셈

```c
// GLSL: each thread = 1 float
layout(local_size_x = 256) in;
layout(set = 0, binding = 0) readonly buffer Input  { float data[]; } inBuf;
layout(set = 0, binding = 1) buffer Output { float data[]; } outBuf;
layout(push_constant) uniform PC { uint count; float multiplier; } pc;

void main() {
    uint idx = gl_GlobalInvocationID.x;
    if (idx < pc.count) {
        outBuf.data[idx] = inBuf.data[idx] * pc.multiplier;
    }
}
```

```c
// Push constant 구조체 정의 (셰이더와 일치)
struct PushConstants {
    uint32_t count;
    float multiplier;
};

// Host 측
VkPipeline computePipeline;
VkPipelineLayout pipelineLayout;
VkDescriptorSet descriptorSet;

// ... 생성 (위 코드 참고)

VkCommandBuffer cmd; // 외부에서 생성됨

vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, computePipeline);
vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, pipelineLayout,
    0, 1, &descriptorSet, 0, nullptr);

PushConstants pc{};
pc.count = 1024;
pc.multiplier = 2.0f;

vkCmdPushConstants(cmd, pipelineLayout,
    VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(PushConstants), &pc);

uint32_t groupCount = (pc.count + 255) / 256;
vkCmdDispatch(cmd, groupCount, 1, 1);
```

---

## 11. 컴퓨트 파이프라인이 사용되는 주요 분야

| 분야 | 설명 |
|------|------|
| **Post-processing** | Bloom, blur, tone mapping, color grading |
| **Particle systems** | 위치/속도 업데이트 |
| **Physics** | 충돌 검사, cloth simulation, fluid simulation |
| **Lighting** | Tiled/Clustered light culling, DDGI, Voxel GI |
| **Animation** | Skinning, morph target, GPU deform |
| **Compute-based Rendering** | GPU-driven culling, indirect draw argument 생성 |
| **AI/ML** | Inference (Vulkan이 TensorRT 대체는 못 하지만 간단한 ML 연산 가능) |
