---
title: Push Constants
slug: push-constants
---

## 소개

푸시 상수(Push Constants)는 별도의 디스크립터 세트나 버퍼 바인딩 없이 셰이더에 소량의 균일(Uniform) 데이터를 빠르게 주입하는 메커니즘이다. `vkCmdPushConstants` 호출을 통해 커맨드 버퍼에 데이터를 직접 기록하며, GPU 내부 고속 레지스터를 거쳐 셰이더의 `layout(push_constant)` 블록으로 전달된다.

> **용어 정리**
> - **Push Constant Range**: 파이프라인 레이아웃에서 선언하는 스테이지 마스크, 오프셋, 바이트 크기의 묶음(`VkPushConstantRange`).
> - **Fast Path**: 버퍼 메모리 매핑이나 디스크립터 세트 갱신보다 오버헤드가 적어 더 빠른 데이터 공급 경로(스펙: "expected to outperform").
> - **maxPushConstantsSize**: 디바이스가 보장하는 푸시 상수 전체 크기 한계(스펙 최소 보장값 128바이트, 일반 외장 GPU는 128~256바이트).
> - **Incremental Update**: 전체 범위를 매번 덮어쓰지 않고 특정 오프셋의 일부 바이트만 선택적으로 갱신하는 기법.

푸시 상수의 선언, 셰이더 작성, 커맨드 버퍼 기록, 동적 오프셋 UBO와의 차이점을 정리한다.

---

## 1. 전체 흐름

```flowchart
flowchart TD
  A["파이프라인 레이아웃 선언:"]
  B["VkPushConstantRange { offset=0, size=64, stageFlags=VERTEX }"]
  C["VkPipelineLayout 생성"]
  D["셰이더 (GLSL):"]
  E["layout(push_constant) uniform PC { mat4 mvp; } pc;"]
  F["드로우 명령 기록:"]
  G(["vkCmdBindPipeline(...)"])
  H(["vkCmdPushConstants(cmd, layout, stageFlags, offset, size, &data)"])
  I(["vkCmdDraw(...)"])
  A --> B --> C
  C --> D --> E --> F --> G --> H --> I
```

**핵심 특징:**

- **버퍼 불필요**: `VkBuffer`나 `VkDeviceMemory` 할당 없이 커맨드 스트림에 값을 직접 포함한다.
- **크기 제한**: 통상 128~256바이트로 매우 제한적이므로 드로우 단위 MVP 행렬, 틴트 색상, 머티리얼 인덱스 등 필수 데이터만 담아야 한다.
- **증분 갱신(Incremental Update) 지원**: 동일한 드로우 루프 안에서 특정 멤버(예: 색상)만 부분적으로 갱신하고 나머지(예: 변환 행렬)는 이전 값을 유지할 수 있다.

---

## 2. 파이프라인 레이아웃 선언

파이프라인 레이아웃 생성 시 사용할 푸시 상수의 오프셋, 크기, 소비 스테이지를 정의한다.

```c
// 아래 §4의 PerDrawData 구조체 크기에 맞춰 선언
VkPushConstantRange pcRange{};
pcRange.offset     = 0;
pcRange.size       = sizeof(PerDrawData);  // 반드시 4의 배수
pcRange.stageFlags = VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT;

VkPipelineLayoutCreateInfo pipelineLayoutCI{};
pipelineLayoutCI.sType                  = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
pipelineLayoutCI.setLayoutCount         = 0;  // 디스크립터 세트가 없어도 무방
pipelineLayoutCI.pSetLayouts            = nullptr;
pipelineLayoutCI.pushConstantRangeCount = 1;
pipelineLayoutCI.pPushConstantRanges    = &pcRange;

VkPipelineLayout pipelineLayout;
vkCreatePipelineLayout(device, &pipelineLayoutCI, nullptr, &pipelineLayout);
```

**크기 및 오프셋 제약 사항:**
- `offset`과 `size`는 **반드시 4의 배수**여야 한다(VUID-vkCmdPushConstants-offset-00368, size-00369).
- `offset + size`는 디바이스 한계인 `VkPhysicalDeviceLimits::maxPushConstantsSize`를 초과할 수 없다.
- 서로 다른 셰이더 스테이지가 각기 다른 오프셋 영역을 사용하도록 다중 범위를 등록할 수 있다.

---

## 3. 셰이더 인터페이스 (GLSL / SPIR-V)

셰이더 내부에서는 `layout(push_constant)` 한정자를 붙인 익명 또는 명명된 uniform 블록으로 선언한다.

```glsl
#version 450

layout(push_constant) uniform PushConstants {
    mat4 mvp;        // 0..63 바이트
    vec4 tintColor;  // 64..79 바이트
    uint objectId;   // 80..83 바이트
    uint flags;      // 84..87 바이트
} pc;

layout(location = 0) in vec3 inPosition;

void main() {
    gl_Position = pc.mvp * vec4(inPosition, 1.0);
}
```

**메모리 레이아웃 규칙:**
- 푸시 상수 블록은 기본적으로 std430 정렬 규칙을 따른다.
- 스칼라는 4바이트, `vec4` 및 `mat4`의 각 열은 16바이트 경계로 정렬된다.
- C++ 구조체와 셰이더 블록의 패딩이 어긋나지 않도록 멤버 선언 순서와 크기를 주의 깊게 설계해야 한다.

---

## 4. `vkCmdPushConstants` — 값 기록

```c
void vkCmdPushConstants(
    VkCommandBuffer      commandBuffer,
    VkPipelineLayout     layout,
    VkShaderStageFlags   stageFlags,
    uint32_t             offset,
    uint32_t             size,
    const void*          pValues);
```

**실제 드로우 기록 예시:**

```c
struct PerDrawData {
    glm::mat4 mvp;
    glm::vec4 tintColor;
    uint32_t  objectId;
    uint32_t  flags;
} pushBlock;

// 데이터 채우기
pushBlock.mvp       = projection * view * model;
pushBlock.tintColor = glm::vec4(1.0f, 0.5f, 0.2f, 1.0f);
pushBlock.objectId  = currentEntityId;
pushBlock.flags     = 0;

// 푸시 상수 기록 후 드로우
vkCmdPushConstants(cmd, pipelineLayout,
    VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT,
    0, sizeof(PerDrawData), &pushBlock);

vkCmdDraw(cmd, vertexCount, 1, 0, 0);
```

### 4.1. 증분 갱신(Incremental Update)

이전 드로우에서 기록한 데이터를 그대로 두고 특정 오프셋 영역만 덮어쓸 수 있다.

```c
// 1. 첫 번째 드로우: 행렬과 색상 전체 기록
vkCmdPushConstants(cmd, layout, VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT,
    0, sizeof(PerDrawData), &pushBlock);
vkCmdDraw(cmd, vertexCount, 1, 0, 0);

// 2. 두 번째 드로우: 변환 행렬은 유지하고 오프셋 64의 색상(vec4)만 변경
glm::vec4 newColor(0.0f, 1.0f, 0.0f, 1.0f);
vkCmdPushConstants(cmd, layout, VK_SHADER_STAGE_FRAGMENT_BIT,
    64, sizeof(glm::vec4), &newColor);
vkCmdDraw(cmd, vertexCount, 1, 0, 0);
```

> **스펙 발췌 (VUID-vkCmdPushConstants-offset-01796)** 지정한 `stageFlags`는 갱신 대상 바이트 범위와 겹치는 모든 파이프라인 레이아웃 범위의 `stageFlags`를 완전히 포함해야 한다. 예를 들어 레이아웃에 `VERTEX | FRAGMENT`로 정의된 범위를 갱신할 때 `stageFlags`에 `VERTEX`만 넘기면 밸리데이션 오류가 발생한다.

> **커맨드 버퍼 초기 상태 주의** 커맨드 버퍼 기록을 시작할 때 푸시 상수 공간의 내용은 **정의되지 않은(Undefined) 상태**다. 셰이더가 해당 값을 읽기 전에 반드시 `vkCmdPushConstants`를 호출하여 유효한 값을 채워 넣어야 한다.

### 4.2. `vkCmdPushConstants2` (Vulkan 1.4 / `VK_KHR_maintenance6`)

Vulkan 1.4 코어 및 `VK_KHR_maintenance6`에서는 매개변수를 `VkPushConstantsInfo` 구조체로 캡슐화한 확장 함수를 제공한다.

```c
VkPushConstantsInfo pushInfo{};
pushInfo.sType      = VK_STRUCTURE_TYPE_PUSH_CONSTANTS_INFO;
pushInfo.layout     = pipelineLayout;
pushInfo.stageFlags = VK_SHADER_STAGE_VERTEX_BIT | VK_SHADER_STAGE_FRAGMENT_BIT;
pushInfo.offset     = 0;
pushInfo.size       = sizeof(PerDrawData);
pushInfo.pValues    = &pushBlock;

vkCmdPushConstants2(cmd, &pushInfo);
```

- 기능과 제약 조건은 기존 `vkCmdPushConstants`와 동일하다.
- `dynamicPipelineLayout` 기능 사용 시 `layout = VK_NULL_HANDLE`로 두고 pNext 체인에 `VkPipelineLayoutCreateInfo`를 연결하여 레이아웃을 동적으로 넘길 수 있다.

---

## 5. 푸시 상수 vs 동적 오프셋 UBO 비교

| 비교 항목 | 푸시 상수 (Push Constants) | 동적 오프셋 UBO |
|-----------|---------------------------|-----------------------|
| **용량 한계** | 128 ~ 256 바이트 | 코어 1.0 보장 최소 16 KB, 1.4/Roadmap 2022 보장 64 KB (`maxUniformBufferRange`) |
| **백킹 메모리** | 없음 (커맨드 스트림 및 GPU 레지스터) | `VkBuffer` + `VkDeviceMemory` 필요 |
| **갱신 API** | `vkCmdPushConstants` (메모리 복사) | `vkCmdBindDescriptorSets` (바이트 오프셋 지정) |
| **갱신 오버헤드** | 극히 낮음 (소량 데이터 즉시 기록) | 상대적으로 낮음 (디스크립터 바인딩 테이블 갱신) |
| **여러 드로우 공유** | 명시적으로 다시 푸시하지 않으면 유지 | 동적 오프셋 변경 시 매 드로우 `vkCmdBindDescriptorSets` + `pDynamicOffsets` 필요 |
| **적합한 데이터** | 드로우별 MVP 행렬, 틴트 색상, 인스턴스 인덱스 | 뼈대 애니메이션 행렬 배열, 조명 파라미터 테이블 |

---

## 6. 대표 활용 패턴

### 6.1. 드로우별 MVP 변환 행렬

```c
VkPushConstantRange range{ VK_SHADER_STAGE_VERTEX_BIT, 0, sizeof(glm::mat4) };
// ... 레이아웃 생성 ...
vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
vkCmdPushConstants(cmd, layout, VK_SHADER_STAGE_VERTEX_BIT, 0, sizeof(glm::mat4), &modelViewProj);
vkCmdDraw(cmd, count, 1, 0, 0);
```

### 6.2. 스테이지 분리 (버텍스 행렬 + 프래그먼트 파라미터)

```c
VkPushConstantRange ranges[2] = {
    { VK_SHADER_STAGE_VERTEX_BIT,   0,  64 },  // mat4 mvp (0~63바이트)
    { VK_SHADER_STAGE_FRAGMENT_BIT, 64, 16 }   // vec4 materialProps (64~79바이트)
};
```

버텍스 셰이더는 0~63바이트, 프래그먼트 셰이더는 64~79바이트만 소비하므로 레지스터 공간을 효율적으로 분할할 수 있다.

### 6.3. 컴퓨트 디스패치 파티션 오프셋

```glsl
layout(push_constant) uniform ComputeParams {
    uint baseIndex;
    uint elementCount;
    float deltaTime;
} params;
```

GPU 컬링이나 파티클 시뮬레이션 시 매 디스패치마다 작업 영역 오프셋을 버퍼 없이 가볍게 전달한다.

---

## 7. 자주 발생하는 오류 점검 목록

### 7.1. 크기 및 정렬 오류

- [ ] `offset` 또는 `size`가 4의 배수가 아님 (VUID-vkCmdPushConstants-offset-00368, size-00369).
- [ ] `offset + size`가 디바이스의 `maxPushConstantsSize`를 초과 (VUID-vkCmdPushConstants-size-00371).
- [ ] `size == 0`으로 호출 (VUID-vkCmdPushConstants-size-arraylength).
- [ ] C++ 구조체 멤버 정렬이 GLSL std430 정렬(16바이트 경계)과 맞지 않아 데이터가 밀리는 현상.

### 7.2. 범위 및 스테이지 불일치

- [ ] `vkCmdPushConstants` 호출 시 전달한 `stageFlags`가 레이아웃에 등록된 해당 영역의 스테이지를 누락 (VUID-offset-01796).
- [ ] 파이프라인 레이아웃에 등록되지 않은 오프셋 영역에 데이터를 기록하려 시도 (VUID-offset-01795).
- [ ] 셰이더 코드에는 `layout(push_constant)` 블록이 없는데 불필요하게 `vkCmdPushConstants` 호출.

### 7.3. 파이프라인 전환 및 상태 유지 오류

- [ ] 커맨드 버퍼 시작 후 첫 드로우 전에 푸시 상수를 기록하지 않아 쓰레기값이 셰이더로 유입.
- [ ] 서로 다른 파이프라인 레이아웃을 가진 파이프라인 A에서 B로 전환할 때, 푸시 상수 영역이 호환되지 않는데 재기록을 생략.
- [ ] 세컨더리 커맨드 버퍼 안에서 프라이머리 커맨드 버퍼의 푸시 상수 상태가 자동으로 상속된다고 오인.

### 7.4. 용량 초과 남용

- [ ] 수 킬로바이트에 달하는 스켈레탈 본 행렬 배열이나 복잡한 머티리얼 구조체를 푸시 상수로 밀어 넣으려다 실패 (UBO 또는 SSBO로 전환 권장).
