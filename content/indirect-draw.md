---
title: Indirect Draw
slug: indirect-draw
---

## 소개

직접 드로우(`vkCmdDraw`, `vkCmdDrawIndexed`)는 정점 수, 인스턴스 수, 오프셋과 같은 드로우 파라미터를 CPU가 커맨드 버퍼에 직접 기록한다. 반면 간접 드로우(Indirect Draw)는 해당 파라미터를 **GPU 메모리에 할당된 버퍼(`VkBuffer`)** 에서 읽어와 렌더링을 실행한다. CPU는 드로우 인자를 담을 버퍼만 연결하고, GPU가 렌더링 시점에 버퍼 내부의 값을 직접 평가하여 드로우를 수행한다.

### 주요 용어
- **Indirect Command**: 드로우 인자를 담은 구조체. 인덱스 사용 여부에 따라 `VkDrawIndexedIndirectCommand`와 `VkDrawIndirectCommand`로 구분되며 메모리 크기와 레이아웃이 서로 다르다.
- **Indirect Buffer**: 간접 드로우 구조체들이 연속으로 저장된 버퍼. 버퍼 생성 시 usage 플래그에 `VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT`를 반드시 포함해야 한다.
- **drawCount**: 단일 간접 드로우 호출에서 연속으로 실행할 인다이렉트 커맨드의 개수. 2개 이상이면 멀티 드로우(Multi-Draw)로 동작한다.
- **Per-Draw 데이터**: 드로우마다 서로 다른 월드 변환 행렬, 머티리얼 인덱스 등을 전달하기 위한 셰이더 스토리지 버퍼(SSBO).

간접 드로우의 핵심 가치는 **CPU의 개입 없이 GPU가 렌더링할 드로우 파라미터를 스스로 결정**한다는 점이다. 오클루전 컬링이나 절두체 컬링을 컴퓨트 셰이더로 수행한 후 유효한 객체 수만 인다이렉트 버퍼에 기록하면, CPU가 수만 개의 드로우 커맨드를 매 프레임 기록하는 병목을 완전히 제거할 수 있다.

---

## 1. 두 종류의 Indirect Command 구조체

인덱스 드로우와 비인덱스 드로우는 구조체 크기와 메모리 배치가 다르므로, 동일한 인다이렉트 버퍼에 두 구조체를 혼용해서는 안 된다.

### 1.1. 인덱스 드로우 — `VkDrawIndexedIndirectCommand`

```c
typedef struct VkDrawIndexedIndirectCommand {
    uint32_t    indexCount;      // 인덱스 개수
    uint32_t    instanceCount;   // 인스턴스 개수 (일반적으로 1)
    uint32_t    firstIndex;      // 인덱스 버퍼 내 시작 오프셋
    int32_t     vertexOffset;    // 정점 버퍼에 더해질 정점 오프셋 (부호 있는 32비트 정수!)
    uint32_t    firstInstance;   // gl_InstanceIndex의 시작 값 (drawIndirectFirstInstance feature 필요)
} VkDrawIndexedIndirectCommand;  // 20 바이트
```

### 1.2. 비인덱스 드로우 — `VkDrawIndirectCommand`

```c
typedef struct VkDrawIndirectCommand {
    uint32_t    vertexCount;     // 정점 개수
    uint32_t    instanceCount;   // 인스턴스 개수 (일반적으로 1)
    uint32_t    firstVertex;     // 첫 정점 오프셋
    uint32_t    firstInstance;   // gl_InstanceIndex의 시작 값 (drawIndirectFirstInstance feature 필요)
} VkDrawIndirectCommand;         // 16 바이트
```

> [!WARNING]
> **`vertexOffset`의 부호 주의**  
> `VkDrawIndexedIndirectCommand`의 `vertexOffset` 필드는 유일하게 **부호 있는 정수(`int32_t`)** 다. 음수 정점 오프셋을 사용할 수 있으므로 구조체 직렬화 시 부호 없는 정수(`uint32_t`)로 캐스팅하지 않도록 주의한다.

### 1.3. 오프셋 및 스트라이드(Stride) 제약
- `offset`은 무조건 **4의 배수**여야 한다.
- `stride`의 "4의 배수 + 구조체 크기 이상" 조건은 `drawCount > 1`일 때만 적용된다. `drawCount <= 1`이면 stride 값은 무시되므로 아무 값이나 넘겨도 된다.
- 인덱스 드로우는 `sizeof(VkDrawIndexedIndirectCommand)`(20바이트), 비인덱스 드로우는 `sizeof(VkDrawIndirectCommand)`(16바이트)를 기본 스트라이드로 전달한다.

---

## 2. 하드웨어 피처 분기: `multiDrawIndirect`

단일 API 호출로 여러 개의 간접 커맨드를 연속 실행(`drawCount > 1`)하려면 `VkPhysicalDeviceFeatures::multiDrawIndirect` 피처가 활성화되어 있어야 한다.

```c
VkPhysicalDeviceFeatures supportedFeatures{};
vkGetPhysicalDeviceFeatures(physicalDevice, &supportedFeatures);

bool canMultiDraw = (supportedFeatures.multiDrawIndirect == VK_TRUE);
```

> [!TIP]
> **`multiDrawIndirect`는 하드 요구가 아니다**  
> 기능을 켜지 않고 조회만 해서 분기하는 패턴이 실전에서 유용하다. 지원하면 배치로, 아니면 단일 루프로 폴백한다.

### 2.1. `maxDrawIndirectCount` 한계값

`multiDrawIndirect` 피처가 켜져 있더라도 한 번의 호출에 넘길 수 있는 `drawCount`는 `VkPhysicalDeviceLimits::maxDrawIndirectCount`를 초과할 수 없다. 일부 모바일 GPU(예: Mali pre-G710)는 이 값이 **1**로 제한되어 멀티 드로우 자체를 사용하지 못한다.

```c
VkPhysicalDeviceProperties props{};
vkGetPhysicalDeviceProperties(physicalDevice, &props);
uint32_t maxBatch = props.limits.maxDrawIndirectCount;
```

### 2.2. 실행 경로 분기 설계

```
supportsMultiDrawIndirect && maxDrawIndirectCount > 1
  ├── 참  → drawCount = N (배치 발행, Push Constant 1회)
  └── 거짓 → drawCount = 1 루프 (커맨드마다 개별 드로우 및 Push Constant 발행)
```

멀티 드로우가 지원되면 동일 파이프라인의 드로우 커맨드들을 한 번의 `vkCmdDrawIndexedIndirect` 호출로 묶어 CPU 기록 오버헤드를 줄일 수 있다.

---

## 3. `firstInstance`와 `drawIndirectFirstInstance`

간접 드로우 구조체의 `firstInstance` 필드에 0이 아닌 값을 지정하려면 **`drawIndirectFirstInstance`** 피처가 활성화되어 있어야 한다.

- 이 피처는 Vulkan 1.0부터 존재하며(`VkPhysicalDeviceFeatures`), `VK_KHR_shader_draw_parameters`와는 무관하다.
- Vulkan 1.0 이상 환경이라도 디바이스 생성 시 `VkPhysicalDeviceFeatures::drawIndirectFirstInstance`를 명시적으로 `VK_TRUE`로 켜지 않으면 `firstInstance`는 **반드시 0**이어야 한다(VUID-VkDrawIndirectCommand-firstInstance-00501, VUID-VkDrawIndexedIndirectCommand-firstInstance-00554).
- 만약 해당 피처를 지원하지 않는 하드웨어라면 `firstInstance`를 0으로 유지하고, 드로우 인덱스를 셰이더로 전달하는 대체 수단을 마련해야 한다.

### 3.1. 드로우 인덱스 전달 방식

| 전달 경로 | 작동 방식 | 필요 조건 |
|-----------|-----------|-----------|
| **Push Constant** | 배치 시작 슬롯(`drawBase`)을 `vkCmdPushConstants`로 전달 | Vulkan 1.0 기본 지원 |
| **`gl_DrawID` / `SV_DrawIndex`** | 간접 드로우 호출 내에서 현재 커맨드의 순번(0 ~ drawCount-1)을 내장 변수로 직접 참조 | `shaderDrawParameters` 피처 (Vulkan 1.1 코어) |

실전에서는 두 방식을 조합하여 각 드로우의 고유 슬롯 번호를 계산한다.

```glsl
// GLSL 버텍스 셰이더
#extension GL_ARB_shader_draw_parameters : enable // 또는 Vulkan 1.1 코어 지원

layout(push_constant) uniform BatchInfo {
    uint drawBase;
};

void main() {
    // 최종 객체 인덱스 = 배치 시작 번호 + 현재 인다이렉트 커맨드 번호
    uint objectIndex = drawBase + gl_DrawID;
    mat4 modelMatrix = perDrawData[objectIndex].model;
    // ...
}
```

> [!NOTE]
> `gl_DrawID`(`DrawIndex` SPIR-V 빌트인)는 인덱스 드로우와 비인덱스 드로우 모두에서 정상 동작한다. 단, 직접 드로우(`vkCmdDraw*`)에서는 항상 0을 반환하므로 간접 드로우 경로에서만 유효한 순번을 갖는다.

### 3.2. Vulkan 1.1 타깃 환경에서의 피처 요구사항

애플리케이션이 `VK_API_VERSION_1_1` 이상을 타깃으로 하더라도 다음 두 피처는 서로 성격이 다르다.
1. `shaderDrawParameters`: Vulkan 1.1에서 코어 명세로 흡수되었지만, 여전히 **선택적 피처**다. 디바이스 생성 시 `VkPhysicalDeviceVulkan11Features::shaderDrawParameters`를 조회하고 `VK_TRUE`로 활성화해야 셰이더가 `DrawParameters` capability를 선언할 수 있다. 미활성 시 `gl_DrawID`는 사용할 수 없다.
2. `drawIndirectFirstInstance`: Vulkan 1.0부터 존재하는 선택적 피처다. 디바이스 생성 시 `VkPhysicalDeviceFeatures::drawIndirectFirstInstance`를 명시적으로 활성화해야 한다.

---

## 4. 인다이렉트 버퍼 생성 및 Staging 업로드

인다이렉트 버퍼는 GPU가 실행 시점에 고속으로 읽어야 하므로 **`DEVICE_LOCAL` 메모리**에 배치하는 것이 원칙이다. CPU에서 직접 기록할 수 없는 디바이스 로컬 메모리인 경우, Host-Visible 스테이징 버퍼에 먼저 기록한 후 커맨드 버퍼 복사(`vkCmdCopyBuffer`)로 데이터를 전송한다.

```c
VkBufferCreateInfo bufferCI{};
bufferCI.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
bufferCI.size = capacity * sizeof(VkDrawIndexedIndirectCommand);
bufferCI.usage = VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT   // 간접 드로우 인자 소스
               | VK_BUFFER_USAGE_TRANSFER_DST_BIT;     // 스테이징 버퍼로부터 복사 수신
bufferCI.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
```

GPU 컬링 컴퓨트 셰이더가 인다이렉트 버퍼의 내용을 직접 수정하는 구조라면 `VK_BUFFER_USAGE_STORAGE_BUFFER_BIT` 플래그도 함께 지정해야 한다.

### 4.1. 스테이징 버퍼 복사

```c
VkBufferCopy copyRegion{};
copyRegion.srcOffset = 0;
copyRegion.dstOffset = 0;
copyRegion.size = drawCount * sizeof(VkDrawIndexedIndirectCommand);

vkCmdCopyBuffer(cmdBuffer, stagingBuffer, indirectBuffer, 1, &copyRegion);
```

---

## 5. 파이프라인 배리어 동기화

스테이징 버퍼 복사 직후 인다이렉트 버퍼는 **Transfer 쓰기(`TRANSFER_WRITE`)** 상태에 머물러 있다. GPU 래스터라이저가 이를 인다이렉트 드로우 인자로 안전하게 읽으려면 적절한 실행 및 메모리 배리어를 삽입해야 한다.

```c
VkBufferMemoryBarrier barrier{};
barrier.sType = VK_STRUCTURE_TYPE_BUFFER_MEMORY_BARRIER;
barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;         // 이전: 버퍼 복사 완료
barrier.dstAccessMask = VK_ACCESS_INDIRECT_COMMAND_READ_BIT; // 이후: 인다이렉트 드로우 읽기
barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
barrier.buffer = indirectBuffer;
barrier.offset = 0;
barrier.size = VK_WHOLE_SIZE;

vkCmdPipelineBarrier(
    cmdBuffer,
    VK_PIPELINE_STAGE_TRANSFER_BIT,      // src stage: 전송 완료 대기
    VK_PIPELINE_STAGE_DRAW_INDIRECT_BIT, // dst stage: 드로우 인자 판독 전 가시화
    0,
    0, nullptr,
    1, &barrier,
    0, nullptr
);
```

컴퓨트 셰이더가 인다이렉트 버퍼를 기록하는 구조라면 `srcStage`를 `VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT`, `srcAccessMask`를 `VK_ACCESS_SHADER_WRITE_BIT`로 지정한다.

> [!WARNING]
> src access는 **쓰기**(`TRANSFER_WRITE`), dst access는 **읽기**(`INDIRECT_COMMAND_READ`)다. src/dst를 둘 다 읽기로 잘못 설정하면 드로우가 복사 결과를 보지 못한다.

---

## 6. 드로우 리스트 배칭 전략

간접 드로우의 효율을 극대화하려면 전체 드로우 목록을 **파이프라인 및 머티리얼별로 그룹화**하여 파이프라인 전환 횟수를 최소화해야 한다.

```
Draw List (Frame)
  ├─ Pipeline A 그룹
  │   ├─ Push Constant: drawBase 전달
  │   └─ vkCmdDrawIndexedIndirect(drawCount = N)
  └─ Pipeline B 그룹
      ├─ Push Constant: drawBase 전달
      └─ vkCmdDrawIndexedIndirect(drawCount = M)
```

```c
if (canMultiDraw) {
    vkCmdPushConstants(cmd, layout, VK_SHADER_STAGE_VERTEX_BIT, 0, sizeof(uint32_t), &baseSlot);
    vkCmdDrawIndexedIndirect(cmd, indirectBuf, baseSlot * stride, batchCount, stride);
} else {
    for (uint32_t i = 0; i < batchCount; ++i) {
        uint32_t currentSlot = baseSlot + i;
        vkCmdPushConstants(cmd, layout, VK_SHADER_STAGE_VERTEX_BIT, 0, sizeof(uint32_t), &currentSlot);
        vkCmdDrawIndexedIndirect(cmd, indirectBuf, currentSlot * stride, 1, stride);
    }
}
```

---

## 7. Per-Draw 데이터 버퍼 (SSBO)

각 드로우 호출마다 고유한 변환 행렬, 머티리얼 속성을 제공하기 위해 대규모 SSBO를 바인딩하고 `drawBase + gl_DrawID`로 색인한다.

```glsl
struct InstanceData {
    mat4 modelMatrix;
    vec4 baseColor;
    uint materialID;
    uint pad[3];
};

layout(std430, set = 0, binding = 0) readonly buffer InstanceBuffer {
    InstanceData instances[];
};
```

- 인스턴스 버퍼 용량이 부족해지면 버퍼를 재할당하고 디스크립터 세트를 갱신(`vkUpdateDescriptorSets`)한다.
- CPU가 매 프레임 데이터를 갱신한다면 `HOST_VISIBLE | HOST_COHERENT` 메모리를 사용하여 맵핑 영역에 직접 기록한다.

---

## 8. 구현 시 주요 검증 체크리스트

- [ ] **구조체 혼용 금지**: 인덱스 구조체(20B)와 비인덱스 구조체(16B)를 단일 인다이렉트 버퍼에 섞어 저장하지 않았는가?
- [ ] **오프셋 및 스트라이드 정렬**: 전달된 `offset`과 `stride`가 모두 4의 배수인가?
- [ ] **전송 플래그 지정**: 스테이징 복사를 수신하는 버퍼에 `VK_BUFFER_USAGE_TRANSFER_DST_BIT`가 지정되었는가?
- [ ] **파이프라인 배리어 적용**: 복사 또는 컴퓨트 기록 완료 후 `VK_PIPELINE_STAGE_DRAW_INDIRECT_BIT` 배리어를 올바르게 삽입했는가?
- [ ] **피처 지원 검증**: `drawCount > 1` 발행 전 `multiDrawIndirect` 피처와 `maxDrawIndirectCount`를 확인했는가?
- [ ] **`firstInstance` 제한 준수**: `drawIndirectFirstInstance` 피처가 비활성화된 환경에서 `firstInstance`를 0으로 고정했는가?
- [ ] **`gl_DrawID` 컨텍스트 확인**: 직접 드로우(`vkCmdDraw*`)가 아닌 간접 드로우 경로에서만 `gl_DrawID` 순번을 참조하고 있는가?
- [ ] **캐시 플러시 확인**: `HOST_COHERENT`가 아닌 Host-Visible 메모리에 기록한 경우 `vkFlushMappedMemoryRanges`를 호출했는가?

---

## 9. 빠른 요약 표

| 설계 요구 | 권장 구현 방식 |
|-----------|----------------|
| **버퍼 메모리 배치** | `DEVICE_LOCAL` 우선, 스테이징 버퍼(`vkCmdCopyBuffer`)로 데이터 전송 |
| **복사 후 동기화** | `TRANSFER_WRITE` → `INDIRECT_COMMAND_READ` 배리어 전환 |
| **멀티 드로우 분기** | `multiDrawIndirect` 활성화 및 `maxDrawIndirectCount > 1`일 때만 배치 호출 |
| **드로우 인덱스 식별** | Push Constant(`drawBase`) + GLSL `gl_DrawID` 조합 |
| **`firstInstance` 사용** | `drawIndirectFirstInstance` 피처 활성화 필수 (1.0부터 존재), 미지원 시 항상 0 |
| **GPU 가시성 컬링** | 인다이렉트 버퍼에 `STORAGE_BUFFER_BIT`를 부여하고 컴퓨트 셰이더에서 기록 |
