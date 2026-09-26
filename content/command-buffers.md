---
title: Command Buffer 관리
slug: command-buffers
---

## 소개

`VkCommandBuffer`는 GPU에 전달할 렌더링, 연산, 메모리 전송 명령을 기록하는 객체다. Vulkan의 커맨드 버퍼는 커맨드 풀(`VkCommandPool`)을 통해 할당하며, 상태 머신(Recording, Executable, Pending 등)에 따라 생명주기가 엄격히 제어된다.

효율적인 GPU 파이프라인 운용을 위해서는 스레드별 커맨드 풀 분리, 개별 버퍼 및 풀 재설정(Reset) 전략, 세컨더리 커맨드 버퍼 상속 규칙을 정확히 이해해야 한다.

| 핵심 개념 | 설명 |
|---|---|
| **Command Pool** | 특정 큐 패밀리에 종속되어 커맨드 버퍼 메모리를 할당하고 관리하는 풀 객체 |
| **Primary Buffer** | 큐에 직접 제출(`vkQueueSubmit`) 가능한 커맨드 버퍼 |
| **Secondary Buffer** | 프라이머리 커맨드 버퍼 내에서 실행(`vkCmdExecuteCommands`)되는 보조 버퍼 |
| **Pending 상태** | `vkQueueSubmit`으로 GPU에 제출되어 실행 중인 상태 (CPU에서 수정 및 해제 불가) |
| **Recording 상태** | `vkBeginCommandBuffer` 호출 후 명령을 기록 중인 상태 |
| **Reset** | 버퍼를 Initial 상태로 되돌려 재사용하는 것. Pool 리셋으로 일괄 처리 가능 |

---

## 1. 커맨드 풀 (`VkCommandPool`)

커맨드 풀은 특정 큐 패밀리에 바인딩되며, 해당 큐 패밀리에 속한 큐에만 버퍼를 제출할 수 있다.

```c
typedef struct VkCommandPoolCreateInfo {
    VkStructureType             sType;
    const void*                 pNext;
    VkCommandPoolCreateFlags    flags;
    uint32_t                    queueFamilyIndex;
} VkCommandPoolCreateInfo;
```

### 1.1. 생성 플래그 (`flags`)

| 플래그 | 설명 및 권장 사항 |
|---|---|
| `VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT` | 개별 버퍼를 `vkResetCommandBuffer`로 재설정할 수 있다. 프레임마다 버퍼를 개별 재기록할 때 필수다. |
| `VK_COMMAND_POOL_CREATE_TRANSIENT_BIT` | 수명이 짧은 커맨드 버퍼(단발성 복사나 즉시 제출용)를 할당할 것임을 드라이버에 알린다. 메모리 할당 최적화 힌트로 작용한다. |
| `VK_COMMAND_POOL_CREATE_PROTECTED_BIT` | 보호된 메모리(Protected Memory)에 접근하는 커맨드 버퍼 전용 풀을 생성한다. |

> `VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT`를 지정하지 않으면 `vkResetCommandBuffer` 호출 시 유효성 검증 오류가 발생하며, 풀 전체 재설정(`vkResetCommandPool`)으로만 초기화할 수 있다.

### 1.2. 큐 패밀리 바인딩 및 스레드 격리

커맨드 풀은 스레드에 안전하지 않다(Thread-unsafe). 멀티스레드 환경에서 병렬로 커맨드 버퍼를 기록하려면 각 스레드가 독립된 `VkCommandPool`을 보유해야 한다. 또한 그래픽스, 컴퓨트, 전송 등 큐 패밀리가 다르면 각각 별도의 풀을 생성해야 한다.

```c
VkCommandPoolCreateInfo poolCI{};
poolCI.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
poolCI.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
poolCI.queueFamilyIndex = graphicsQueueFamilyIndex;

VkCommandPool graphicsCommandPool;
vkCreateCommandPool(device, &poolCI, nullptr, &graphicsCommandPool);
```

---

## 2. 커맨드 버퍼 할당 및 해제

커맨드 버퍼는 `vkAllocateCommandBuffers`로 풀에서 생성한다.

```c
VkCommandBufferAllocateInfo allocInfo{};
allocInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
allocInfo.commandPool = graphicsCommandPool;
allocInfo.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY; // 또는 VK_COMMAND_BUFFER_LEVEL_SECONDARY
allocInfo.commandBufferCount = 2;

VkCommandBuffer commandBuffers[2];
vkAllocateCommandBuffers(device, &allocInfo, commandBuffers);
```

### 해제와 파괴

- 개별 해제: `vkFreeCommandBuffers`를 호출한다. 단, 풀 전체를 파괴할 계획이라면 개별 해제 없이 풀 파괴 시 일괄 정리할 수 있다.
- 풀 파괴: `vkDestroyCommandPool`을 호출하면 해당 풀에서 할당된 모든 커맨드 버퍼가 함께 소멸한다.
- **제약**: 실행 중인(Pending 상태) 커맨드 버퍼가 포함되어 있으면 풀을 재설정하거나 파괴할 수 없다(VUID-vkResetCommandPool-commandPool-00040, VUID-vkDestroyCommandPool-commandPool-00041). 반드시 Fence를 대기하거나 `vkDeviceWaitIdle`을 거쳐야 한다.

---

## 3. 커맨드 버퍼 수명 주기

```
[Initial] ──(vkBeginCommandBuffer)──> [Recording] ──(vkEndCommandBuffer)──> [Executable]
   ↑                                                                                │
   │                                                                        (vkQueueSubmit)
   │                                                                                ↓
   ├──── (vkResetCommandBuffer / vkResetCommandPool) ←── [Recording/Executable]  [Pending]
   │                                                                    (GPU 완료 후 재사용 가능)
```

| 상태 | 설명 |
|---|---|
| **Initial** | 할당 직후 또는 재설정(Reset)된 상태. 기록을 시작할 수 있다. |
| **Recording** | `vkBeginCommandBuffer` 호출 후 명령을 추가하는 상태. |
| **Executable** | `vkEndCommandBuffer`를 마친 상태. 큐에 제출할 수 있다. |
| **Pending** | `vkQueueSubmit` 후 GPU가 작업을 처리 중인 상태. 리소스를 덮어쓰거나 수정할 수 없다. |
| **Invalid** | 실행 의존성을 지닌 세컨더리 버퍼가 재설정되는 등의 이유로 유효성을 잃은 상태. 재설정 후 재기록해야 한다. |

---

## 4. 기록 시작과 종료 (`vkBeginCommandBuffer`)

```c
VkCommandBufferBeginInfo beginInfo{};
beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
beginInfo.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;

vkBeginCommandBuffer(cmdBuffer, &beginInfo);
// 명령 기록: 바인딩, 렌더링, 배리어, 디스패치 등...
vkCmdDraw(cmdBuffer, ...);
vkEndCommandBuffer(cmdBuffer);
```

### `VkCommandBufferUsageFlagBits`

| 플래그 | 설명 |
|---|---|
| `VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT` | 한 번 제출한 후 다시 기록하기 전까지 재제출하지 않는 버퍼. 드라이버가 커맨드 버퍼 메모리를 인플레이스(in-place)로 최적화할 수 있어 매 프레임 재기록에 권장된다. |
| `VK_COMMAND_BUFFER_USAGE_SIMULTANEOUS_USE_BIT` | 이전 제출이 아직 실행 중(Pending)일 때도 동일 버퍼를 다시 제출하거나 다른 큐에 동시 제출할 수 있도록 허용한다. |
| `VK_COMMAND_BUFFER_USAGE_RENDER_PASS_CONTINUE_BIT` | 세컨더리 커맨드 버퍼가 렌더 패스 실행 범위 내부에서 동작함을 명시한다. |

---

## 5. 재설정 전략: 버퍼 리셋 vs 풀 리셋

매 프레임 커맨드 버퍼를 다시 기록할 때 두 가지 재설정 방식을 사용할 수 있다.

### 5.1. 개별 버퍼 재설정 (`vkResetCommandBuffer`)

풀 생성 시 `VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT` 플래그가 필요하다.

```c
// flags = 0: 할당된 내부 메모리를 유지하여 다음 기록 시 재할당 비용 절감
// flags = VK_COMMAND_BUFFER_RESET_RELEASE_RESOURCES_BIT: 메모리를 풀로 반환
vkResetCommandBuffer(cmdBuffer, 0);
```

- **장점**: 프레임 단위로 완료된 특정 버퍼만 선택적으로 초기화하고 재기록할 수 있다.
- **권장 플래그**: 성능을 위해 `RELEASE_RESOURCES_BIT` 대신 `0`을 사용하여 내부 할당 메모리를 유지한다.

### 5.2. 풀 전체 재설정 (`vkResetCommandPool`)

풀에 속한 모든 커맨드 버퍼를 한 번에 Initial 상태로 되돌린다.

```c
vkResetCommandPool(device, commandPool, 0);
```

- **장점**: 수십~수백 개의 단기 보조 버퍼를 사용하는 작업에서 개별 리셋 호출 오버헤드를 줄인다.
- **주의**: 풀 내에 GPU가 아직 실행 중인(Pending) 커맨드 버퍼가 하나라도 있으면 스펙 위반이다.

---

## 6. 세컨더리 커맨드 버퍼 (Secondary Command Buffer)

세컨더리 커맨드 버퍼는 드로우 콜 기록을 여러 CPU 코어에 분산할 때 핵심적인 역할을 한다.

### 6.1. 상속 정보 (`VkCommandBufferInheritanceInfo`)

세컨더리는 큐에 직접 제출할 수 없으며, 프라이머리 커맨드 버퍼가 시작한 렌더 패스 또는 렌더링 범위 상태를 상속받아야 한다.

```c
VkCommandBufferInheritanceInfo inheritanceInfo{};
inheritanceInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_INHERITANCE_INFO;
inheritanceInfo.renderPass = renderPass; // 호환되는 렌더 패스
inheritanceInfo.subpass = 0;
inheritanceInfo.framebuffer = framebuffer;

VkCommandBufferBeginInfo beginInfo{};
beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
beginInfo.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT
                | VK_COMMAND_BUFFER_USAGE_RENDER_PASS_CONTINUE_BIT;
beginInfo.pInheritanceInfo = &inheritanceInfo;

vkBeginCommandBuffer(secondaryCmd, &beginInfo);
vkCmdDraw(secondaryCmd, ...);
vkEndCommandBuffer(secondaryCmd);

// 프라이머리에서 실행
vkCmdBeginRenderPass(primaryCmd, &rpBeginInfo, VK_SUBPASS_CONTENTS_SECONDARY_COMMAND_BUFFERS);
vkCmdExecuteCommands(primaryCmd, 1, &secondaryCmd);
vkCmdEndRenderPass(primaryCmd);
```

### 6.2. Dynamic Rendering 환경에서의 세컨더리 버퍼

Dynamic Rendering(`vkCmdBeginRendering`)을 사용할 때는 `renderPass` 대신 `VkCommandBufferInheritanceRenderingInfo`를 상속 구조체의 `pNext`에 연결해야 한다.

```c
VkCommandBufferInheritanceRenderingInfo inheritanceRendering{};
inheritanceRendering.sType =
    VK_STRUCTURE_TYPE_COMMAND_BUFFER_INHERITANCE_RENDERING_INFO;
inheritanceRendering.colorAttachmentCount = 1;
inheritanceRendering.pColorAttachmentFormats = &colorFormat;
inheritanceRendering.depthAttachmentFormat = depthFormat;
inheritanceRendering.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT;

VkCommandBufferInheritanceInfo inheritanceInfo{};
inheritanceInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_INHERITANCE_INFO;
inheritanceInfo.pNext = &inheritanceRendering;

VkCommandBufferBeginInfo beginInfo{};
beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
beginInfo.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
beginInfo.pInheritanceInfo = &inheritanceInfo;

vkBeginCommandBuffer(secondaryCmd, &beginInfo);
vkCmdDraw(secondaryCmd, ...);
vkEndCommandBuffer(secondaryCmd);

// 프라이머리에서 실행
vkCmdBeginRendering(primaryCmd, &renderingInfo); // flags에 VK_RENDERING_CONTENTS_SECONDARY_COMMAND_BUFFERS_BIT 필수
vkCmdExecuteCommands(primaryCmd, 1, &secondaryCmd);
vkCmdEndRendering(primaryCmd);
```

> **스펙 원문 (VUID-vkCmdExecuteCommands-flags-06026)** `flags` member of `VkCommandBufferInheritanceRenderingInfo` must be equal to the `VkRenderingInfo::flags` parameter to `vkCmdBeginRendering`, excluding `VK_RENDERING_CONTENTS_SECONDARY_COMMAND_BUFFERS_BIT`.
> **VUID-vkCmdExecuteCommands-colorAttachmentCount-06027** `colorAttachmentCount` must be equal to `vkCmdBeginRendering`'s `colorAttachmentCount`.
>
> primary와 secondary의 포맷/개수 불일치가 가장 흔한 VUID 실수다.

---

## 7. 주요 주의사항

### 커맨드 풀 관리

- **큐 패밀리 불일치**: 풀 생성 시 지정한 `queueFamilyIndex`와 다른 큐 패밀리에 커맨드 버퍼를 제출하면 오류가 발생한다.
- **멀티스레드 동시 접근**: 커맨드 풀은 동기화되지 않으므로 서로 다른 스레드가 동일한 풀에서 동시에 버퍼를 할당, 해제, 재설정할 수 없다. 스레드당 전용 풀을 할당해야 한다.
- **빈번한 풀 생성/파괴 지양**: 커맨드 풀은 초기화 시점에 생성하고 애플리케이션 수명 주기 동안 재사용하며, 메모리 압박이 심할 때만 `vkTrimCommandPool`을 호출하여 여유 메모리를 OS에 반환한다.

### 커맨드 버퍼 상태 및 동기화

- **Pending 상태 침범 금지**: `vkQueueSubmit`으로 제출한 커맨드 버퍼는 연결된 Fence가 신호될 때까지 Pending 상태다. 완료 확인 없이 `vkResetCommandBuffer`, `vkBeginCommandBuffer`, `vkFreeCommandBuffers`를 호출해서는 안 된다.
- **`ONE_TIME_SUBMIT_BIT` 버퍼 재제출 금지**: 해당 플래그로 기록된 버퍼는 한 번 제출된 후 다시 기록하기 전까지 유효하지 않다.
- **세컨더리 상속 검증**: Dynamic Rendering 환경에서 세컨더리 버퍼의 상속 포맷이나 샘플 수가 프라이머리 렌더링 범위와 일치하지 않으면 검증 레이어 오류가 발생한다.
