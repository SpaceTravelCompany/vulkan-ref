---
title: 동기화 (Synchronization)
slug: synchronization
---

## 소개

Vulkan은 CPU와 GPU가 비동기로 동작한다. 애플리케이션이 명령을 제출한 뒤 GPU가 연산을 마칠 때까지 CPU는 자동으로 기다리지 않는다. 또한 GPU 내부 파이프라인도 여러 작업 단위를 병렬로 스케줄링하므로, 이전 작업의 쓰기가 완료되기 전에 후속 작업이 데이터를 읽으면 데이터 레이스가 발생한다.

> **초보자를 위한 용어 정리**
> - **파이프라인 스테이지**: GPU 내부의 작업 단계. 정점 처리 → 래스터화 → 프래그먼트 처리 → 출력 등 여러 단계가 순차적으로 진행된다.
> - **메모리 가시성**: "A가 쓴 데이터를 B가 볼 수 있는 상태"가 되는 것. GPU는 캐시를 쓰기 때문에, 쓰기가 완료되어도 다른 단계에서 즉시 보이지 않을 수 있다.
> - **큐**: GPU에 명령을 제출하는 통로. 그래픽스 큐, 컴퓨트 큐, 전송 큐 등이 있다.

Vulkan은 실행 순서(Execution Dependency)와 메모리 가시성(Memory Visibility)을 보장하기 위해 4가지 동기화 프리미티브를 제공한다. 각 프리미티브는 제어 대상과 유효 범위가 다르므로 목적에 맞게 선택해야 한다.

| 프리미티브 | 동기화 범위 | 신호(Signal) 주체 | 대기(Wait) 주체 | 핵심 용도 |
|---|---|---|---|---|
| **Fence** | GPU → Host | GPU (Queue) | Host (CPU) | GPU 명령 제출 완료 여부를 CPU에서 확인 |
| **Semaphore** | GPU → GPU | GPU (Queue) | GPU (Queue) | 서로 다른 큐 간 또는 프레젠테이션 동기화 |
| **Event** | GPU ↔ GPU / Host | GPU 또는 Host | GPU 또는 Host | 동일 큐 내 세밀한 비동기 지연 동기화 |
| **Pipeline Barrier** | GPU → GPU | 명령 기록 시점 | GPU (Pipeline) | 동일 큐 내 스테이지 실행 순서, 캐시 플러시, 이미지 레이아웃 전환 |

---

## 1. Fence (GPU → Host 동기화)

Fence는 CPU가 GPU 작업의 완료를 확인할 때 사용하는 프리미티브다.

```c
VkFence fence;
VkFenceCreateInfo fenceCI{};
fenceCI.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
fenceCI.flags = VK_FENCE_CREATE_SIGNALED_BIT; // 첫 프레임 대기 통과를 위해 신호 상태로 초기화 가능
vkCreateFence(device, &fenceCI, nullptr, &fence);

VkSubmitInfo submitInfo{};
// 커맨드 버퍼 설정...
vkQueueSubmit(queue, 1, &submitInfo, fence);

// CPU에서 GPU 작업 완료 대기 (블로킹)
vkWaitForFences(device, 1, &fence, VK_TRUE, UINT64_MAX);

// 다음 제출 전에 반드시 비신호 상태로 재설정
vkResetFences(device, 1, &fence);
```

### 주요 특성

- **상태**: 이진(Signaled / Unsignaled) 상태만 가진다.
- **제출 및 대기**: `vkQueueSubmit`의 인자로 넘겨 GPU가 작업을 마치면 신호 상태가 되며, `vkWaitForFences`로 블로킹 대기하거나 `vkGetFenceStatus`로 비동기 폴링한다.
- **재설정 필수**: 신호된 Fence를 재사용하려면 반드시 `vkResetFences`를 호출해야 한다.
- **프레임 인 플라이트(Frames-in-Flight)**: CPU가 이전 프레임에서 제출한 명령 버퍼와 유니폼 버퍼를 덮어쓰지 않도록 프레임 단위 동기화에 사용한다.

```c
// 더블/트리플 버퍼링 펜스 패턴
const uint32_t MAX_FRAMES_IN_FLIGHT = 2;
VkFence inFlightFences[MAX_FRAMES_IN_FLIGHT];
uint32_t currentFrame = 0;

// 프레임 루프
vkWaitForFences(device, 1, &inFlightFences[currentFrame], VK_TRUE, UINT64_MAX);
vkResetFences(device, 1, &inFlightFences[currentFrame]);

// 리소스 갱신 및 명령 버퍼 기록...
vkQueueSubmit(graphicsQueue, 1, &submitInfo, inFlightFences[currentFrame]);
currentFrame = (currentFrame + 1) % MAX_FRAMES_IN_FLIGHT;
```

---

## 2. Semaphore (GPU → GPU 동기화)

Semaphore는 큐 내부 또는 서로 다른 큐 간에 GPU 작업 간 순서를 맞출 때 사용한다. CPU를 블로킹하지 않고 GPU 하드웨어 스케줄러가 신호 수신 여부를 확인하여 후속 작업을 진행한다.

### Binary Semaphore

이진 상태(Signaled / Unsignaled)만 가지는 전통적인 세마포어다. 대표적으로 스왑체인 이미지 획득과 그래픽스 렌더링, 프레젠테이션 큐 사이의 순서를 조정할 때 필수다.

```c
VkSemaphore imageAvailableSemaphore;
VkSemaphore renderFinishedSemaphore;
vkCreateSemaphore(device, &semCI, nullptr, &imageAvailableSemaphore);
vkCreateSemaphore(device, &semCI, nullptr, &renderFinishedSemaphore);

// 1. 스왑체인 이미지 획득 (완료 시 imageAvailableSemaphore 신호)
vkAcquireNextImageKHR(device, swapchain, UINT64_MAX, imageAvailableSemaphore, VK_NULL_HANDLE, &imageIndex);

// 2. 렌더링 명령 제출
VkPipelineStageFlags waitStages[] = { VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT };
VkSubmitInfo submitInfo{};
submitInfo.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
submitInfo.waitSemaphoreCount = 1;
submitInfo.pWaitSemaphores = &imageAvailableSemaphore;
submitInfo.pWaitDstStageMask = waitStages;
submitInfo.signalSemaphoreCount = 1;
submitInfo.pSignalSemaphores = &renderFinishedSemaphore;
vkQueueSubmit(graphicsQueue, 1, &submitInfo, inFlightFence);

// 3. 화면 표시 제출 (renderFinishedSemaphore 대기)
VkPresentInfoKHR presentInfo{};
presentInfo.sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR;
presentInfo.waitSemaphoreCount = 1;
presentInfo.pWaitSemaphores = &renderFinishedSemaphore;
presentInfo.pSwapchains = &swapchain;
presentInfo.pImageIndices = &imageIndex;
vkQueuePresentKHR(presentQueue, &presentInfo);
```

### Timeline Semaphore (Vulkan 1.2 Core)

Vulkan 1.2부터 코어로 도입된 타임라인 세마포어는 단조 증가하는 64비트 정수 값을 가진다. 하나의 객체로 여러 작업의 진행 단계를 값 기준으로 추적할 수 있으며, CPU에서도 직접 값을 신호하거나 대기할 수 있다.

```c
VkSemaphoreTypeCreateInfo timelineCI{};
timelineCI.sType = VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO;
timelineCI.semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE;
timelineCI.initialValue = 0;

VkSemaphoreCreateInfo semCI{};
semCI.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO;
semCI.pNext = &timelineCI;
vkCreateSemaphore(device, &semCI, nullptr, &timelineSemaphore);

// Host(CPU)에서 특정 값 대기
VkSemaphoreWaitInfo waitInfo{};
waitInfo.sType = VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO;
waitInfo.semaphoreCount = 1;
waitInfo.pSemaphores = &timelineSemaphore;
uint64_t targetValue = 42;
waitInfo.pValues = &targetValue;
vkWaitSemaphores(device, &waitInfo, UINT64_MAX);

// Host(CPU)에서 임의 값 신호
VkSemaphoreSignalInfo signalInfo{};
signalInfo.sType = VK_STRUCTURE_TYPE_SEMAPHORE_SIGNAL_INFO;
signalInfo.semaphore = timelineSemaphore;
signalInfo.value = 43;
vkSignalSemaphore(device, &signalInfo);
```

| 비교 항목 | Binary Semaphore | Timeline Semaphore |
|---|---|---|
| **내부 상태** | 0 또는 1 (이진) | 64비트 정수 (단조 증가) |
| **재사용 방식** | 대기 통과 시 자동 소비 | 값이 증가함에 따라 재사용 가능 |
| **Host 대기 / 신호** | 지원하지 않음 | `vkWaitSemaphores` / `vkSignalSemaphore` 지원 |
| **스왑체인 프레젠테이션** | 사용 가능 | 스펙상 미지원 (Binary Semaphore만 사용) |

---

## 3. Event (세밀한 비동기 동기화)

Event는 동일한 큐 안에서 신호(`vkCmdSetEvent`)와 대기(`vkCmdWaitEvents`) 시점을 명령 버퍼 상에서 분리할 수 있는 프리미티브다.

파이프라인 배리어는 배치 지점에서 즉시 실행 파이프라인을 멈추지만, Event는 신호 설정과 대기 지점 사이에 의존성이 없는 다른 독립 명령을 삽입하여 GPU 유휴 시간을 줄일 수 있다.

```flowchart
flowchart TD
  A1["Barrier 방식: vkCmdDraw(A)"] --> A2["vkCmdPipelineBarrier"]
  A2 --> A3["무관한 작업 C도 대기"]
  A3 --> A4["vkCmdDispatch(B)"]

  B1["Event 방식: vkCmdDraw(A)"] --> B2["vkCmdSetEvent(A 완료 신호)"]
  B2 --> B3["vkCmdDraw(C) — 대기 없이 실행"]
  B3 --> B4["vkCmdWaitEvents(A 신호 확인)"]
  B4 --> B5["vkCmdDispatch(B)"]
```

### `vkCmdWaitEvents`와 스테이지 마스크 규칙

`vkCmdWaitEvents` 호출 시 전달하는 `srcStageMask`는 신호를 발생시킨 `vkCmdSetEvent`의 `stageMask`에 포함된 스테이지를 **모두 포함(superset)**해야 한다.

`vkCmdSetEvent`에서 지정한 스테이지보다 더 넓은 범위를 `vkCmdWaitEvents`의 `srcStageMask`로 지정하는 것은 유효하지만, `vkCmdSetEvent`에 포함된 스테이지가 `srcStageMask`에서 누락되면 스펙 위반이다.

```c
// 작업 A 완료 시 이벤트 신호 설정
vkCmdSetEvent(cmd, event, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT);

// 작업 A와 무관한 드로우 콜 실행 (대기 없이 즉시 스케줄링)
vkCmdDraw(cmd, ...);

// 작업 A의 출력을 컴퓨트 셰이더에서 읽기 전 대기
// srcStageMask는 setEvent의 COLOR_ATTACHMENT_OUTPUT_BIT를 반드시 포함해야 한다.
vkCmdWaitEvents(cmd, 1, &event,
    VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT, // srcStageMask: setEvent 스테이지 포함
    VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,          // dstStageMask: 이후 컴퓨트 셰이더 대기
    0, nullptr,
    0, nullptr,
    1, &imageMemoryBarrier);

vkCmdDispatch(cmd, ...);
```

### `vkCmdSetEvent2` / `vkCmdWaitEvents2` (Vulkan 1.3 Synchronization2)

레거시 `vkCmdSetEvent`는 실행 의존성(stage)만 받고 액세스 마스크를 받지 않아 메모리 배리어를 `vkCmdWaitEvents`에서만 정의했다. Vulkan 1.3 `VK_KHR_synchronization2`에서는 `VkDependencyInfo`를 통해 `vkCmdSetEvent2` 시점에도 메모리 가시성과 액세스 범위를 일관되게 정의할 수 있다.

```c
VkMemoryBarrier2 memBarrier{};
memBarrier.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER_2;
memBarrier.srcStageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT;
memBarrier.srcAccessMask = VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT;
memBarrier.dstStageMask = VK_PIPELINE_STAGE_2_COMPUTE_SHADER_BIT;
memBarrier.dstAccessMask = VK_ACCESS_2_SHADER_READ_BIT;

VkDependencyInfo depInfo{};
depInfo.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
depInfo.memoryBarrierCount = 1;
depInfo.pMemoryBarriers = &memBarrier;

vkCmdSetEvent2(cmd, event, &depInfo);
// ... 무관한 명령 실행 ...
vkCmdWaitEvents2(cmd, 1, &event, &depInfo);
```

### Event 생성 및 리셋

Event는 한 번 신호되면 **자동으로 리셋되지 않는다**. 재사용하려면 명시적으로 리셋해야 한다.

```c
VkEvent event;
VkEventCreateInfo eventCI{};
eventCI.sType = VK_STRUCTURE_TYPE_EVENT_CREATE_INFO;
vkCreateEvent(device, &eventCI, nullptr, &event);

// GPU 명령 버퍼 내에서 리셋 (다음 vkCmdSetEvent 전에 호출)
vkCmdResetEvent(cmd, event, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT);

// 또는 Host(CPU)에서 리셋
vkResetEvent(device, event);
```

> [!WARNING]
> 호스트에서 신호된 이벤트(`vkSetEvent`)를 `vkCmdWaitEvents`로 기다릴 때는 `srcStageMask`에 `VK_PIPELINE_STAGE_HOST_BIT`를 포함해야 한다(VUID-vkCmdWaitEvents-srcStageMask-01158).

**주요 제약:**
- `VK_EVENT_CREATE_DEVICE_ONLY_BIT`로 생성한 이벤트는 호스트 API(`vkSetEvent`/`vkResetEvent`/`vkGetEventStatus`)를 사용할 수 없다.
- `VK_KHR_portability_subset`이 활성화된 일부 디바이스(MoltenVK 등)에서는 이벤트 자체를 지원하지 않을 수 있다.

---

## 4. Pipeline Barrier (실행 순서 및 메모리 가시성)

Pipeline Barrier는 동일 큐 내에서 가장 광범위하게 사용하는 동기화 메커니즘이다.

1. **실행 의존성(Execution Dependency)**: `srcStageMask`의 작업이 완료된 후 `dstStageMask`의 작업이 시작되도록 제한한다.
2. **메모리 의존성(Memory Dependency)**: `srcAccessMask`에 명시된 캐시 쓰기를 메모리에 플러시(flush)하고, `dstAccessMask`가 읽기 전에 캐시를 무효화(invalidate)한다.
3. **이미지 레이아웃 전환(Image Layout Transition)**: 이미지의 구현 정의 메모리 배치를 용도에 맞게 전환한다(예: 전송 쓰기 → 셰이더 읽기).

```c
VkImageMemoryBarrier barrier{};
barrier.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER;
barrier.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
barrier.newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
barrier.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
barrier.image = textureImage;
barrier.subresourceRange.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
barrier.subresourceRange.baseMipLevel = 0;
barrier.subresourceRange.levelCount = 1;
barrier.subresourceRange.baseArrayLayer = 0;
barrier.subresourceRange.layerCount = 1;

vkCmdPipelineBarrier(cmdBuffer,
    VK_PIPELINE_STAGE_TRANSFER_BIT,        // srcStageMask: 전송 완료 대기
    VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, // dstStageMask: 프래그먼트 셰이더 진입 전 대기
    0,
    0, nullptr,
    0, nullptr,
    1, &barrier);
```

---

## 5. 파이프라인 스테이지 (Pipeline Stages)

GPU 파이프라인의 작업 단계를 비트마스크로 표현한다.

| 카테고리 | 스테이지 비트 | 설명 |
|---|---|---|
| **그래픽스** | `VERTEX_SHADER`, `TESSELLATION_CONTROL/EVALUATION_SHADER`, `GEOMETRY_SHADER`, `FRAGMENT_SHADER` | 셰이더 스테이지 |
| | `VERTEX_INPUT`, `EARLY_FRAGMENT_TESTS`, `LATE_FRAGMENT_TESTS`, `COLOR_ATTACHMENT_OUTPUT` | 고정 함수/출력 |
| **컴퓨트** | `COMPUTE_SHADER` | 컴퓨트 디스패치 |
| **전송** | `TRANSFER` | 복사, 클리어, 블릿 명령 |
| **호스트** | `HOST` | CPU에서의 메모리 쓰기/신호 (예: `vkSetEvent`) |
| **확장** | `TASK_SHADER_EXT`, `MESH_SHADER_EXT` | 메시 셰이더 파이프라인 |
| | `RAY_TRACING_SHADER_KHR`, `ACCELERATION_STRUCTURE_BUILD_KHR` | 레이 트레이싱 |
| | `TRANSFORM_FEEDBACK_EXT`, `CONDITIONAL_RENDERING_EXT` | 기타 확장 |
| **집합** | `ALL_GRAPHICS`, `ALL_COMMANDS` | 그래픽스 전체 / 모든 명령 |
| **가상** | `TOP_OF_PIPE`, `BOTTOM_OF_PIPE` | 실제 실행 없음 (아래 주의사항 참조) |

- **`srcStageMask`**: 배리어를 통과하기 전 완료되어야 할 이전 명령들의 파이프라인 단계.
- **`dstStageMask`**: 배리어 통과 후 비로소 실행을 시작할 후속 명령들의 파이프라인 단계.

### 가상 스테이지의 용도와 주의사항

- `VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT`: 파이프라인의 최상단 단계다. 실제 하드웨어 실행을 나타내지 않으므로 `srcStageMask`로 지정하면 이전 명령의 완료를 기다리지 않는 효과를 낸다.
- `VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT`: 파이프라인의 최하단 단계다. `dstStageMask`로 지정하면 후속 명령들이 이 단계를 통과할 때까지 기다리므로, 후속 작업의 실제 실행을 막지 못한다.
- 실제 메모리 쓰기/읽기 작업과 동기화할 때는 가상 스테이지 대신 해당 리소스를 실제로 다루는 스테이지(`TRANSFER`, `COLOR_ATTACHMENT_OUTPUT`, `COMPUTE_SHADER` 등)를 명시해야 한다.

---

## 6. 액세스 마스크와 메모리 가시성

액세스 마스크(`VkAccessFlags`)는 특정 스테이지 내부에서 발생하는 구체적인 읽기/쓰기 작업의 종류를 지정한다.

- `srcAccessMask`: 배리어 이전에 보장해야 할 쓰기 작업 종류(`TRANSFER_WRITE`, `COLOR_ATTACHMENT_WRITE` 등).
- `dstAccessMask`: 배리어 이후 유효한 데이터를 읽어야 할 작업 종류(`SHADER_READ`, `COLOR_ATTACHMENT_READ` 등).

> **스펙 규칙**: 동기화 범위(Synchronization Scope)는 스테이지 마스크로 먼저 한정되고, 그 내부에서 액세스 마스크로 지정된 연산에 대해서만 캐시 플러시와 무효화가 일어난다. 배리어에 메모리 배리어를 하나도 전달하지 않으면 실행 순서(Execution Dependency)만 보장되며 캐시 정합성은 보장되지 않는다.

---

## 7. 렌더 패스 내부 배리어의 제약

`vkCmdPipelineBarrier`를 렌더 패스 실행 구간(`vkCmdBeginRenderPass` ~ `vkCmdEndRenderPass`) 내부에서 호출할 때는 다음 제약이 따른다:

- 버퍼 메모리 배리어(`pBufferMemoryBarriers`)를 사용할 수 없다.
- 큐 패밀리 소유권 이전을 수행할 수 없다 (`srcQueueFamilyIndex != dstQueueFamilyIndex` 금지).
- 이미지 레이아웃을 변경할 수 없다 (`oldLayout == newLayout`이어야 함).
- `TRANSFER`나 `COMPUTE_SHADER` 등 프레임버퍼 공간(framebuffer-space) 이외의 스테이지를 지정할 수 없다.
- 소스 스테이지 마스크가 framebuffer-space 스테이지(`EARLY_FRAGMENT_TESTS`, `FRAGMENT_SHADER`, `LATE_FRAGMENT_TESTS`, `COLOR_ATTACHMENT_OUTPUT`)를 포함하면 `VK_DEPENDENCY_BY_REGION_BIT`가 필수다(VUID-vkCmdPipelineBarrier-dependencyFlags-07891).
- `VkRenderPass` 사용 시, 배리어의 스테이지/액세스 범위는 해당 서브패스의 자기 의존성(self-dependency) 범위와 동일하거나 그 부분집합이어야 한다(VUID-vkCmdPipelineBarrier-None-07889).
- 다중 뷰 렌더 패스에서 서브패스 내부 배리어를 사용할 때는 `VK_DEPENDENCY_VIEW_LOCAL_BIT`도 함께 지정해야 한다(VUID-VkSubpassDependency-srcSubpass-00872).

---

## 8. VK_KHR_synchronization2 (Vulkan 1.3 Core)

Vulkan 1.3에 코어로 통합된 `VK_KHR_synchronization2`는 기존 32비트 마스크의 한계를 극복하고 사용성을 개선했다.

1. **64비트 마스크**: `VkPipelineStageFlags2`와 `VkAccessFlags2`를 도입하여 확장 기능 스테이지를 온전히 수용한다.
2. **명시적 NONE 플래그**: `VK_PIPELINE_STAGE_2_NONE`과 `VK_ACCESS_2_NONE`을 제공하여 불필요한 가상 스테이지 우회를 방지한다.
3. **구조체 통합**: `VkMemoryBarrier2`, `VkBufferMemoryBarrier2`, `VkImageMemoryBarrier2` 내부에 `srcStageMask`, `dstStageMask`, `srcAccessMask`, `dstAccessMask`가 함께 포함되어 설정 불일치를 줄인다.
4. **단일 진입점**: 인자가 많던 기존 API 대신 `VkDependencyInfo` 단일 구조체로 `vkCmdPipelineBarrier2`를 호출한다.

```c
VkImageMemoryBarrier2 barrier2{};
barrier2.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
barrier2.srcStageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT;
barrier2.srcAccessMask = VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT;
barrier2.dstStageMask = VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT;
barrier2.dstAccessMask = VK_ACCESS_2_SHADER_SAMPLED_READ_BIT;
barrier2.oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
barrier2.newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
barrier2.image = renderTargetImage;
barrier2.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};

VkDependencyInfo depInfo{};
depInfo.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
depInfo.imageMemoryBarrierCount = 1;
depInfo.pImageMemoryBarriers = &barrier2;

vkCmdPipelineBarrier2(cmd, &depInfo);
```

---

## 9. 실전 선택 가이드

| 해결하려는 상황 | 추천 프리미티브 |
|---|---|
| CPU가 특정 프레임의 커맨드 버퍼 완료를 확인하고 리소스를 재사용할 때 | **Fence** |
| 스왑체인 이미지 획득 대기 및 프레젠테이션 큐 제출 동기화 | **Binary Semaphore** |
| 컴퓨트 큐와 그래픽스 큐 간 비동기 작업 파이프라이닝 | **Timeline Semaphore** |
| 렌더 타깃 완료 후 셰이더 샘플링 텍스처로 레이아웃 전환 및 캐시 플러시 | **Pipeline Barrier** (`vkCmdPipelineBarrier2`) |
| 렌더링 결과와 무관한 드로우 콜을 사이에 끼워 넣고 세밀하게 대기할 때 | **Event** (`vkCmdSetEvent2` / `vkCmdWaitEvents2`) |

### 배리어 작성 시 핵심 원칙

- `ALL_COMMANDS_BIT`나 `ALL_GRAPHICS_BIT`는 전체 파이프라인을 비우므로 디버깅용으로만 제한하고, 실전에서는 필요한 최소 스테이지만 명시한다.
- 스테이지 마스크와 액세스 마스크의 쌍이 논리적으로 성립해야 한다. 예를 들어 `TRANSFER` 스테이지에 `COLOR_ATTACHMENT_WRITE` 액세스를 지정하면 검증 레이어 오류가 발생한다.
- 렌더 패스 간 전환은 가능한 한 서브패스 의존성(`VkSubpassDependency`)이나 패스 외부의 파이프라인 배리어로 명확히 분리한다.
