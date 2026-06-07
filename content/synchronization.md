---
title: 동기화 전체
slug: synchronization
---

## 소개

Vulkan은 GPU와 CPU가 **비동기**로 동작한다. CPU가 "이거 그려"라고 명령을 내려도, GPU가 언제 끝내는지는 CPU가 알 수 없다. 그런데 예를 들어 CPU가 "아까 렌더링한 결과 읽자"고 했는데 GPU가 아직 작업 중이라면? 읽은 데이터가 엉망이 된다.

이런 문제를 막기 위해 **동기화(Synchronization)** 가 필요하다. "A 작업이 끝난 뒤에 B를 해"라는 순서 보장을 Vulkan에서는 4가지 도구로 제어한다.

> **초보자를 위한 용어 정리**
> - **파이프라인 스테이지**: GPU 내부의 작업 단계. 정점 처리 → 래스터화 → 프래그먼트 처리 → 출력 등 여러 단계가 순차적으로 진행된다.
> - **메모리 가시성**: "A가 쓴 데이터를 B가 볼 수 있는 상태"가 되는 것. GPU는 캐시를 쓰기 때문에, 쓰기가 완료되어도 다른 단계에서 즉시 보이지 않을 수 있다.
> - **큐**: GPU에 명령을 제출하는 통로. 그래픽스 큐, 컴퓨트 큐, 전송 큐 등이 있다.

Vulkan의 동기화 프리미티브는 크게 **Fence**, **Semaphore**, **Event**, **Pipeline Barrier** 네 가지로 나뉜다. 각각이 동작하는 범위와 용도가 다르므로, 상황에 맞게 선택하는 것이 중요하다.

---

---

## 1. 개요: 어디서 누구를 동기화하는가

Vulkan 스펙(Chapter 7)은 다음과 같이 정의한다:

> Fences can be used to communicate to the host that execution of some task on the device has completed.
> Semaphores can be used to control resource access across multiple queues.
> Events provide a fine-grained synchronization primitive … within a single queue.
> Pipeline barriers also provide synchronization control within a command buffer.

핵심은 **동기화 대상과 범위**다.

| 프리미티브 | 동기화 범위 | 신호 주체 | 대기 주체 | 용도 |
|-----------|-----------|---------|---------|------|
| **Fence** | GPU → Host | GPU (queue) | Host (CPU) | 커맨드 버퍼 제출 완료를 CPU가 확인 |
| **Semaphore** | GPU → GPU (큐 간) | GPU (queue) | GPU (queue) | 다른 큐의 작업이 끝날 때까지 기다림 |
| **Event** | GPU → GPU (동일 큐 내) + Host ↔ GPU | GPU 또는 Host | GPU (command buffer) 또는 Host | 커맨드 버퍼 내/외에서 세밀한 동기화 |
| **Pipeline Barrier** | GPU → GPU (동일 큐 내) | 커맨드 버퍼 기록 시점 | GPU (하드웨어) | 스테이지 간 메모리 가시성 + 레이아웃 전환 |

---

---

## 2. Fence (GPU → Host 동기화)

Fence는 **CPU가 GPU 작업의 완료를 기다릴 때** 사용한다.

> **비유**: 택배를 보낸 뒤 "배송 완료" 문자를 받는 것과 같다. CPU는 GPU에게 작업(택배)을 맡기고, Fence(배송 알림)가 오기 전에는 리소스를 건드리지 않는다.

```c
// 제출할 때 fence를 건다
VkFence fence;
vkCreateFence(device, &fenceCI, nullptr, &fence);

VkSubmitInfo submit{};
// ... command buffer 등 설정
vkQueueSubmit(queue, 1, &submit, fence);

// CPU에서 GPU 작업이 끝날 때까지 블로킹
vkWaitForFences(device, 1, &fence, VK_TRUE, UINT64_MAX);

// 또는 논블로킹 폴링
vkGetFenceStatus(device, &fence); // VK_SUCCESS or VK_NOT_READY

// 재사용 전에 리셋 (비신호 상태로)
vkResetFences(device, 1, &fence);
```

**특징:**

- **이진(binary)** 상태만 가짐: signaled / unsignaled
- `vkQueueSubmit`의 마지막 인자로 전달
- `vkWaitForFences` / `vkGetFenceStatus`로 CPU에서 대기
- **재사용 전에 반드시 `vkResetFences` 해야 함**
- 주로 swapchain acquire, 프레임 리소스 재활용 시점 확인에 사용

**실전 예:** 프레임 단위로 fence 배열을 두고, CPU가 "이전 프레임의 커맨드 버퍼가 끝났는지" 확인한 후 리소스를 재사용한다.

```c
// 더블/트리플 버퍼링 패턴
const int MAX_FRAMES_IN_FLIGHT = 2;
VkFence inFlightFences[MAX_FRAMES_IN_FLIGHT];
int currentFrame = 0;

// 매 프레임: 먼저 해당 프레임의 fence가 끝날 때까지 기다린다
vkWaitForFences(device, 1, &inFlightFences[currentFrame], VK_TRUE, UINT64_MAX);
vkResetFences(device, 1, &inFlightFences[currentFrame]);

// ... 렌더링 ...

// 제출할 때 fence를 다시 건다
vkQueueSubmit(queue, 1, &submit, inFlightFences[currentFrame]);

currentFrame = (currentFrame + 1) % MAX_FRAMES_IN_FLIGHT;
```

---

---

## 3. Semaphore (GPU → GPU, 큐 간 동기화)

Semaphore는 **GPU 작업 간의 의존성**을 정의한다. 서로 다른 큐(예: 그래픽 큐와 프레젠테이션 큐) 사이에서 "A 작업이 끝나야 B 작업을 시작해도 된다"를 표현한다.

> **비유**: 릴레이 경기에서 배턴 넘기기. 앞 주자(그래픽 큐)가 달리기를 마쳐야 뒤 주자(프레젠테이션 큐)가 출발할 수 있다. CPU는 심판 역할일 뿐, 배턴 넘기기에 직접 관여하지 않는다.

Fence와 달리 Semaphore는 **GPU끼리만 주고받는 신호**다. CPU는 여기서 대기하지 않는다. (단, 아래 Timeline Semaphore는 예외)

```c
VkSemaphore imageAvailableSemaphore;
VkSemaphore renderFinishedSemaphore;
vkCreateSemaphore(device, &semCI, nullptr, &imageAvailableSemaphore);
vkCreateSemaphore(device, &semCI, nullptr, &renderFinishedSemaphore);

// 제출: signalSemaphore는 이 작업이 끝나면 신호를 보낸다
VkSubmitInfo submit{};
submit.signalSemaphoreCount = 1;
submit.pSignalSemaphores = &renderFinishedSemaphore;
vkQueueSubmit(graphicsQueue, 1, &submit, VK_NULL_HANDLE);

// 프레젠테이션: waitSemaphore가 신호될 때까지 기다렸다가 제출
VkPresentInfoKHR present{};
present.waitSemaphoreCount = 1;
present.pWaitSemaphores = &renderFinishedSemaphore;
vkQueuePresentKHR(presentQueue, &present);
```

**Vulkan 1.2 / VK_KHR_timeline_semaphore**부터는 **Timeline Semaphore**를 사용할 수 있다:

```c
// Timeline semaphore 생성
VkSemaphoreTypeCreateInfo timelineCI{};
timelineCI.semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE;
timelineCI.initialValue = 0;

VkSemaphoreCreateInfo semCI{};
semCI.pNext = &timelineCI;
vkCreateSemaphore(device, &semCI, nullptr, &timelineSem);

// GPU가 특정 값에 도달할 때까지 Host에서 대기 가능
VkSemaphoreWaitInfo waitInfo{};
waitInfo.pSemaphores = &timelineSem;
waitInfo.pValues = &targetValue;
waitInfo.semaphoreCount = 1;
vkWaitSemaphores(device, &waitInfo, UINT64_MAX);

// Host에서 직접 신호 가능
VkSemaphoreSignalInfo signalInfo{};
signalInfo.value = newValue;
vkSignalSemaphore(device, &signalInfo);
```

**Binary Semaphore vs Timeline Semaphore:**

| 항목 | Binary (기본값) | Timeline |
|------|----------------|----------|
| 상태 | 0 또는 1 (signaled/unsignaled) | 64비트 정수 (단조 증가) |
| 재사용 | 수동으로 unsignal 필요 | 값이 증가하면 자동으로 재신호 가능 |
| Host 신호 | 불가능 | `vkSignalSemaphore`로 가능 |
| Host 대기 | 불가능 | `vkWaitSemaphores`로 가능 |
| 프레젠테이션 | 사용 가능 | 사용 불가 (binary 필수) |

Timeline semaphore 하나로 여러 의존성을 값 기반으로 관리할 수 있어서, **멀티 큐 환경에서 이진 세마포어를 여러 개 관리할 필요가 줄어든다.**

---

---

## 4. Event (GPU 내/GPU-Host 세밀한 동기화)

Event는 **동일 큐 안에서** 커맨드 버퍼 내의 특정 지점에 **신호를 걸고, 그 신호를 기다리는** 용도다. Pipeline Barrier와 가장 큰 차이는 **set과 wait가 분리되어 있어서 중간에 다른 명령을 끼워넣을 수 있다**는 점이다.

> **언제 쓰나?** 렌더링 작업 A의 결과물이 필요한 컴퓨트 작업 B가 있다고 하자. 그런데 A와 B 사이에 A와 상관없는 UI 그리기 C가 있다. Pipeline Barrier를 쓰면 C까지 불필요하게 기다려야 하지만, Event를 쓰면 C는 자유롭게 실행되고 B만 A를 기다린다.

---

### 4.1. Pipeline Barrier와의 차이 — 더 자세히

**Pipeline Barrier**는 barrier를 기준으로 위/아래를 나눈다:

```cmdstack
vkCmdDraw(A) ← COLOR_OUTPUT
---
vkCmdPipelineBarrier(
  src=COLOR_ATTACHMENT_OUTPUT,
  dst=COMPUTE_SHADER)
---
vkCmdDispatch(B) ← COMPUTE_SHADER
```

→ barrier 위(A)가 다 끝나야 barrier 아래(B)가 시작된다.
→ **A와 B 사이에 아무것도 끼울 수 없다.** barrier가 모든 명령을 양분하기 때문.
→ 만약 A와 B 사이에 A랑 관계없는 draw C가 있어도, C는 불필요하게 A가 끝날 때까지 기다려야 한다.

**Event**는 set과 wait가 분리되어 있다:

```cmdstack
vkCmdDraw(A) ← COLOR_OUTPUT
vkCmdSetEvent(event, COLOR_OUTPUT) ← A 끝!
---
vkCmdDraw(C) ← A랑 상관없는 작업 (기다리지 않고 실행)
vkCmdDraw(D) ← A랑 상관없는 작업 (기다리지 않고 실행)
---
vkCmdWaitEvents(..., event,
  src=COLOR_OUTPUT, dst=COMPUTE) ← A 끝날 때까지 기다림
---
vkCmdDispatch(B) ← COMPUTE_SHADER
```

→ A가 끝나면 **event만 신호**되고, 그 이후 C, D는 A를 기다리지 않고 바로 실행된다.
→ **wait 지점에서만** event가 걸릴 때까지 기다린 후 B가 실행된다.
→ 즉 C, D가 A보다 먼저 시작될 수도 있고, A가 끝난 후에 시작될 수도 있다. GPU 스케줄러가 판단한다. 중요한 건 "wait에 도달했을 때 A가 끝나 있기만 하면 된다"는 점이다.

**정리:**
| | Pipeline Barrier | Event |
|--|----------------|-------|
| 적용 범위 | barrier 위/아침 모든 명령 | set-wait 사이 명령은 자유로움 |
| 중간 명령 | 불가능 (다 막힘) | 가능 (영향 안 줌) |
| 의존성 위치 | barrier 기록 시점에 고정 | set과 wait를 각각 원하는 곳에 배치 |

---

### 4.2. `vkCmdWaitEvents` 인수 상세

```c
void vkCmdWaitEvents(
    VkCommandBuffer             commandBuffer,
    uint32_t                    eventCount,        // 기다릴 event 개수
    const VkEvent*              pEvents,           // event 배열
    VkPipelineStageFlags        srcStageMask,      // event가 기다리는 src 스테이지
    VkPipelineStageFlags        dstStageMask,      // 이후 실행될 dst 스테이지
    uint32_t                    memoryBarrierCount,       // memory barrier
    const VkMemoryBarrier*      pMemoryBarriers,
    uint32_t                    bufferMemoryBarrierCount, // buffer barrier
    const VkBufferMemoryBarrier* pBufferMemoryBarriers,
    uint32_t                    imageMemoryBarrierCount,  // image barrier
    const VkImageMemoryBarrier* pImageMemoryBarriers
);
```

인자가 무려 11개로 `vkCmdPipelineBarrier`와 거의 동일하다. 차이는:

- `eventCount` / `pEvents`: "이 event(들)이 signal될 때까지" 기다린다는 점
- `srcStageMask`: **event가 signal된 스테이지** 중에서 어떤 스테이지까지 포함할지 (setEvent 때 지정한 스테이지와 일치해야 함)
- `dstStageMask`: wait 이후 실행될 명령 중 **이 스테이지들**만 wait 뒤에 실행됨
- `memory/buffer/image barriers`: 배리어와 동일. event 신호 이후 메모리 가시성 보장이 필요한 경우 추가

**반드시 setEvent 때의 stage와 waitEvents 때의 srcStage를 일치시켜야 한다.**

```c
// 좋은 예
vkCmdSetEvent(cmd, event, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT);
vkCmdWaitEvents(cmd, 1, &event,
    VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,  // ← set과 같음 👍
    VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
    0, nullptr, 0, nullptr, 0, nullptr);

// 나쁜 예 (srcStage 불일치)
vkCmdSetEvent(cmd, event, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT);
vkCmdWaitEvents(cmd, 1, &event,
    VK_PIPELINE_STAGE_VERTEX_SHADER_BIT,            // ← 불일치! ❌
    VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
```

---

### 4.3. 기본 사용 예제

```c
VkEvent event;
VkEventCreateInfo eventCI{};
eventCI.sType = VK_STRUCTURE_TYPE_EVENT_CREATE_INFO;
vkCreateEvent(device, &eventCI, nullptr, &event);

vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, gbufferPipeline);
vkCmdDraw(cmd, ...);   // ← A: gbuffer에 렌더링 (COLOR_OUTPUT)

// A가 끝나면 event 신호
vkCmdSetEvent(cmd, event, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT);

// A랑 상관없는 작업들은 자유롭게 실행
vkCmdDraw(cmd, ...);   // ← C: UI 드로우

// A의 결과가 필요할 때 wait
vkCmdWaitEvents(cmd, 1, &event,
    VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,  // A의 COLOR_OUTPUT이 끝날 때까지
    VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT,           // 이후 FS는 wait 후에 실행
    0, nullptr, 0, nullptr, 0, nullptr);

vkCmdDispatch(cmd, ...); // ← B: gbuffer 읽는 컴퓨트
```

---

### 4.4. `vkCmdResetEvent` — 수동으로 event를 unsignal

Event는 한 번 signal되면 자동으로 unsignal되지 않는다. 필요하면 수동으로 리셋한다.

```c
// 커맨드 버퍼 안에서 리셋
vkCmdResetEvent(cmd, event, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT);

// 또는 CPU에서 직접 리셋
vkResetEvent(device, event);
```

---

### 4.5. CPU에서 Event 직접 제어

`vkSetEvent` / `vkResetEvent` / `vkGetEventStatus`로 CPU가 직접 event 상태를 바꾸거나 확인할 수 있다.

```c
// CPU에서 직접 신호 (GPU 작업이 끝나지 않았어도 강제로 signal)
vkSetEvent(device, event);

// CPU에서 직접 리셋
vkResetEvent(device, event);

// 현재 상태 확인 (GPU가 아직 signal 안 했으면 VK_EVENT_RESET)
VkResult status = vkGetEventStatus(device, event);
if (status == VK_EVENT_SET) {
    // event가 signal됨
} else if (status == VK_EVENT_RESET) {
    // 아직 signal 안 됨
}
```

CPU에서 강제로 `vkSetEvent`를 호출하면 GPU가 실제로 해당 지점에 도달하지 않았더라도 event가 signal 상태가 된다. 주 용도는 디버깅이나 복구 처리.

---

### 4.6. `vkCmdSetEvent2` / `vkCmdWaitEvents2` (Vulkan 1.3)

Vulkan 1.3 (`VK_KHR_synchronization2`)에서는 Event도 새 API로 개선되었다.

```c
// vkCmdSetEvent2: VkDependencyInfo를 통해 stage + barrier를 함께 전달
VkDependencyInfo depInfo{};
VkMemoryBarrier2 memBarrier{};
memBarrier.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER_2;
memBarrier.srcStageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT;
memBarrier.srcAccessMask = VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT;
memBarrier.dstStageMask = VK_PIPELINE_STAGE_2_COMPUTE_SHADER_BIT;
memBarrier.dstAccessMask = VK_ACCESS_2_SHADER_READ_BIT;
depInfo.memoryBarrierCount = 1;
depInfo.pMemoryBarriers = &memBarrier;

vkCmdSetEvent2(cmd, event, &depInfo);
// ... 중간 명령들 ...
vkCmdWaitEvents2(cmd, 1, &event, &depInfo);
```

**레거시 vs Synchronization2 차이:**

| 항목 | `vkCmdSetEvent` (1.0) | `vkCmdSetEvent2` (1.3) |
|------|----------------------|----------------------|
| stage 지정 | 별도 파라미터 | `VkDependencyInfo` 안에 포함 |
| memory barrier | `vkCmdWaitEvents`에서만 지정 | `vkCmdSetEvent2`에서도 지정 가능 |
| access mask | setEvent에는 없음 (waitEvents에서만) | setEvent에 access mask 포함 |
| stage/access 분리 | stage와 access가 따로놀 수 있음 | stage + access가 같은 구조체로 묶임 |

레거시 `vkCmdSetEvent`는 stage만 받고 access mask는 받지 않는다. 즉, setEvent 자체로는 **execution dependency만 생성**되고, 실제 메모리 가시성은 waitEvents의 memory barrier에서 처리해야 한다.

`synchronization2`에서는 `setEvent2`에 `VkDependencyInfo`로 stage + access + barrier를 한 번에 전달할 수 있어서, setEvent 단계에서 메모리 가시성까지 정의할 수 있다.

```c
// 레거시: setEvent는 stage만, access는 waitEvents의 barrier에서
vkCmdSetEvent(cmd, event, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT);
vkCmdWaitEvents(cmd, 1, &event,
    VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
    VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
    1, &memBarrier,   // ← access는 여기서
    0, nullptr, 0, nullptr);

// synchronization2: setEvent 자체에 stage + access + barrier 포함
VkDependencyInfo depInfo{};
depInfo.memoryBarrierCount = 1;
depInfo.pMemoryBarriers = &memBarrier;  // ← set에 barrier 포함
vkCmdSetEvent2(cmd, event, &depInfo);
vkCmdWaitEvents2(cmd, 1, &event, &depInfo);
```

---

### 4.7. Event의 제약

- **같은 큐 내에서만** 사용 가능. 큐 간 Event 동기화는 불가능 (Semaphore 사용).
- Event는 **CPU에서 강제로 signal/unsignal할 수 있으므로** GPU 파이프라인과 CPU 실행 순서가 꼬이지 않게 주의해야 한다.
- `vkCreateEvent` 시 `VK_EVENT_CREATE_DEVICE_ONLY_BIT`를 설정하면 CPU 접근을 막고 GPU 전용으로 만들 수 있다. 드라이버 최적화에 도움.

```c
VkEventCreateInfo eventCI{};
eventCI.flags = VK_EVENT_CREATE_DEVICE_ONLY_BIT; // GPU 전용
eventCI.sType = VK_STRUCTURE_TYPE_EVENT_CREATE_INFO;
vkCreateEvent(device, &eventCI, nullptr, &deviceOnlyEvent);
```

- `VK_KHR_portability_subset`을 사용하는 일부 구현체(iOS/Metal)에서는 Event가 아예 지원되지 않을 수 있다. `VkPhysicalDevicePortabilitySubsetFeaturesKHR::events` 확인 필요.

---

---

## 5. Pipeline Barrier (GPU 내, 커맨드 순서 + 메모리 가시성)

Pipeline Barrier는 가장 자주 사용되는 동기화 수단이다. **이미지 레이아웃 전환**이나 **메모리 가시성 보장**이 필요할 때 거의 반드시 쓴다고 생각하면 된다. 커맨드 버퍼 기록 시점에 **어떤 스테이지들의 작업이 끝나야 다음 스테이지들이 시작될 수 있는지**를 지정한다.

```c
// 전송 → 셰이더 읽기 예제
VkImageMemoryBarrier barrier{};
barrier.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL;
barrier.newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
barrier.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
barrier.image = image;
barrier.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};

vkCmdPipelineBarrier(cmdBuffer,
    VK_PIPELINE_STAGE_TRANSFER_BIT,      // src: 전송이 끝날 때까지 기다림
    VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT, // dst: 이후 프래그먼트 셰이더는 barrier 후에 실행
    0,
    0, nullptr,   // memory barrier 없음
    0, nullptr,   // buffer barrier 없음
    1, &barrier); // image barrier 1개
```

---

---

## 소개

Vulkan에서 **파이프라인 배리어**는 GPU 명령 사이의 **메모리·실행 순서**를 보장하는 동기화 장치다.

---

---

## 1. 왜 필요한가

GPU는 다음을 동시에 한다.

- **파이프라인 스테이지**가 겹쳐서 실행됨 (예: 이전 드로우의 프래그먼트가 돌아가는 동안 다음 드로우의 버텍스가 시작될 수 있음)
- **캐시** 때문에, "쓴 값"이 곧바로 "다음 읽기"에 보이지 않을 수 있음
- **이미지 레이아웃**이 스테이지/용도마다 다름 (예: 전송용 vs 셰이더 샘플링용)

그래서 "여기까지 쓴 작업이 끝난 뒤, 여기부터 읽기/쓰기를 시작해라"를 명시해 주어야 한다. 그걸 **배리어**로 표현한다.

---

---

## 2. 함수 시그니처 (개념)

```
vkCmdPipelineBarrier(
    commandBuffer,           // 명령을 넣을 커맨드 버퍼
    srcStageMask,           // 이 스테이지들(포함)의 작업이 끝날 때까지 기다림
    dstStageMask,           // 이 스테이지들의 작업은 배리어를 지난 뒤에만 실행됨
    dependencyFlags,        // 배리어 간 의존성 옵션
    memoryBarrierCount,     // 전역 메모리 배리어 개수
    pMemoryBarriers,        // 전역 메모리 배리어 배열
    bufferMemoryBarrierCount,
    pBufferMemoryBarriers,  // 특정 버퍼만 대상
    imageMemoryBarrierCount,
    pImageMemoryBarriers    // 특정 이미지만 대상 (+ 레이아웃 전환)
);
```

- **스테이지 마스크**: "어디까지 끝나야 배리어를 통과하는지(src)" / "배리어 통과 후 어디부터 실행해도 되는지(dst)"를 **파이프라인 스테이지** 단위로 지정.
- **배리어 종류**:
  - **MemoryBarrier**: 모든 메모리(전역).
  - **BufferMemoryBarrier**: 특정 버퍼 구간만.
  - **ImageMemoryBarrier**: 특정 이미지(+ 서브리소스) + **이미지 레이아웃 전환**.

---

---

## 3. 파이프라인 스테이지 (Pipeline Stage)

작업이 "어느 단계"에 해당하는지 구분하는 비트 플래그다. 배리어는 다음 두 가지로 동기화한다.

- **srcStageMask ("이전")**: **이 스테이지들에 해당하는 작업이 다 끝날 때까지** 기다린다. 끝나야 배리어를 통과한다.
- **dstStageMask ("이후")**: **이 스테이지들에 해당하는 작업은 배리어를 지난 뒤에만** 실행된다. 배리어 앞에서는 시작하지 않는다.

| 스테이지 | 의미 |
|----------|------|
| `TOP_OF_PIPE` | 파이프라인 진입 직후 (아직 실제 작업 전). "아무것도 안 했다"는 표시로 자주 씀. |
| `DRAW_INDIRECT` | 간접 드로우/디스패치 인덱스 읽기 |
| `VERTEX_INPUT` | 버텍스 인덱스/속성 읽기 |
| `VERTEX_SHADER` | 버텍스 셰이더 |
| `TESSELLATION_*` | 테셀레이션 |
| `GEOMETRY_SHADER` | 지오메트리 셰이더 |
| `EARLY_FRAGMENT_TESTS` | 프래그먼트 이전 깊이/스텐실 테스트 |
| `FRAGMENT_SHADER` | 프래그먼트 셰이더 |
| `LATE_FRAGMENT_TESTS` | 프래그먼트 이후 깊이/스텐실 |
| `COLOR_ATTACHMENT_OUTPUT` | 컬러 어태치먼트 쓰기 |
| `COMPUTE_SHADER` | 컴퓨트 셰이더 |
| `TRANSFER` | 복사(copy) 연산 |
| `BOTTOM_OF_PIPE` | 파이프라인 끝. "여기까지 다 끝났다" 표시. |
| `HOST` | CPU가 읽기/쓰기하기 직전·직후 |

- **srcStageMask**: 이 비트로 지정한 스테이지들(포함)에서 일어나는 작업이 **모두 완료될 때까지** 기다린다. 완료되기 전에는 배리어를 통과하지 않는다.
- **dstStageMask**: 배리어 **이후**에 제출된 명령들 중, 이 비트로 지정한 스테이지들에 해당하는 작업은 **배리어를 통과한 뒤에만** 실행된다. 즉, (1) src 스테이지들이 끝날 때까지 대기 → (2) 배리어 통과 → (3) dst 스테이지들이 그다음에 진행.

**스테이지 범위 최소화**: src는 가능한 이른 TOP에 가깝게, dst는 가능한 BOTTOM에 가깝게 두어서 대기를 줄이는 것이 좋다.

---

---

## 3.1 VkPipelineStageFlagBits - 각 비트 상세

`VkPipelineStageFlagBits`는 위 스테이지 마스크를 구성하는 **개별 비트**다. 여러 비트를 OR해서 `VkPipelineStageFlags`(비트셋)로 넘긴다.

### 실행 순서(개념상)

그래픽 파이프라인에서 명령이 지나가는 흐름은 대략 다음과 같다.

```
TOP_OF_PIPE
    → DRAW_INDIRECT
    → VERTEX_INPUT
    → VERTEX_SHADER
    → TESSELLATION_CONTROL_SHADER → TESSELLATION_EVALUATION_SHADER
    → GEOMETRY_SHADER
    → FRAGMENT_SHADER  (또는 EARLY_FRAGMENT_TESTS → FRAGMENT_SHADER → LATE_FRAGMENT_TESTS)
    → COLOR_ATTACHMENT_OUTPUT
    → BOTTOM_OF_PIPE
```

컴퓨트/전송은 이 흐름과 독립적으로 스테이지가 있다: `COMPUTE_SHADER`, `TRANSFER`, `HOST`.

### 코어 스테이지

| 비트 | 의미 |
|------|------|
| `VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT` | 파이프라인 최상단. **가상 스테이지**로, "아직 아무 작업도 안 함"을 나타낼 때 씀. src로 쓰면 "이전 명령이 다 끝난 뒤"를 기다리게 할 수 있음. |
| `VK_PIPELINE_STAGE_DRAW_INDIRECT_BIT` | `vkCmdDrawIndirect*` / `vkCmdDispatchIndirect*`가 **인디렉트 버퍼를 읽는** 시점. |
| `VK_PIPELINE_STAGE_VERTEX_INPUT_BIT` | 버텍스/인덱스 버퍼 **읽기**. |
| `VK_PIPELINE_STAGE_VERTEX_SHADER_BIT` | 버텍스 셰이더 실행. |
| `VK_PIPELINE_STAGE_TESSELLATION_CONTROL_SHADER_BIT` | 테셀레이션 컨트롤 셰이더. |
| `VK_PIPELINE_STAGE_TESSELLATION_EVALUATION_SHADER_BIT` | 테셀레이션 이벨류에이션 셰이더. |
| `VK_PIPELINE_STAGE_GEOMETRY_SHADER_BIT` | 지오메트리 셰이더. |
| `VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT` | 프래그먼트 셰이더 실행. |
| `VK_PIPELINE_STAGE_EARLY_FRAGMENT_TESTS_BIT` | 프래그먼트 셰이더 **이전** 깊이·스텐실 테스트/쓰기. |
| `VK_PIPELINE_STAGE_LATE_FRAGMENT_TESTS_BIT` | 프래그먼트 셰이더 **이후** 깊이·스텐실 테스트/쓰기. |
| `VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT` | 컬러 어태치먼트 **쓰기**. |
| `VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT` | 컴퓨트 셰이더 실행. |
| `VK_PIPELINE_STAGE_TRANSFER_BIT` | `vkCmdCopy*` 등 **전송(복사)** 연산. |
| `VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT` | 파이프라인 최하단. **가상 스테이지**로, "여기까지 모두 완료"를 나타낼 때 씀. dst로 쓰면 "다음 작업 전체보다 먼저" 실행되게 할 수 있음. |
| `VK_PIPELINE_STAGE_HOST_BIT` | **호스트(CPU)**가 `vkMapMemory` 등으로 읽기/쓰기하는 시점. |

### 집합 스테이지 (편의용)

| 비트 | 의미 |
|------|------|
| `VK_PIPELINE_STAGE_ALL_GRAPHICS_BIT` | 위 그래픽 파이프라인에 등장하는 **모든** 스테이지를 한 번에 지정. "그래픽 전부" 기다리기/통과할 때 사용. |
| `VK_PIPELINE_STAGE_ALL_COMMANDS_BIT` | 그래픽·컴퓨트·전송·호스트 등 **모든 명령**이 지나가는 스테이지를 포함. 가장 넓은 범위. |

### 확장 스테이지 (기능 켜진 경우)

- `TRANSFORM_FEEDBACK_EXT`: 변환 피드백 쓰기.
- `CONDITIONAL_RENDERING_EXT`: 조건부 렌더링에서 조건 버퍼 읽기.
- `RAY_TRACING_*_KHR` / `_NV`: 레이 트레이싱 셰이더·AS 빌드.
- `FRAGMENT_DENSITY_PROCESS_EXT`, `FRAGMENT_SHADING_RATE_*`: VRS/밀도.
- `TASK_SHADER_EXT`, `MESH_SHADER_EXT`: 태스크/메시 셰이더.
- `COMMAND_PREPROCESS_NV`: 커맨드 전처리.

### 가상 스테이지 (TOP / BOTTOM)

- **TOP_OF_PIPE**: 실제 HW 작업은 없고, "파이프라인 진입 직후"를 나타내는 **가상** 스테이지.
  - **src**로 쓰면: "그 이전에 제출된 모든 작업이 완료될 때까지 대기"하는 효과.
- **BOTTOM_OF_PIPE**: "파이프라인 종료 직전"을 나타내는 **가상** 스테이지.
  - **dst**로 쓰면: "배리어 이후의 모든 작업보다 먼저 이 스테이지가 통과"하는 효과.

실제 메모리 액세스가 발생하는 스테이지와 짝을 맞출 때는, "그 액세스를 수행하는 **실제** 스테이지"를 쓰는 것이 좋다. 예: 전송 쓰기 → `TRANSFER`, 셰이더 읽기 → `FRAGMENT_SHADER` 또는 `COMPUTE_SHADER`.

### 배리어에서의 사용 예

- **이미지 레이아웃 전환 (아직 아무도 안 씀 → 전송이 씀)**
  - src: `TOP_OF_PIPE` (이전 작업만 기다림), dst: `TRANSFER`.
- **전송 쓰기 → 셰이더에서 텍스처 읽기**
  - src: `TRANSFER`, dst: `FRAGMENT_SHADER`(또는 해당하는 셰이더 스테이지).
- **렌더 타겟 쓰기 → 다음 패스/컴퓨트에서 읽기**
  - src: `COLOR_ATTACHMENT_OUTPUT`, dst: `FRAGMENT_SHADER` / `COMPUTE_SHADER` 등.

---

---

## 4. 액세스 마스크 (Access Mask)

"어떤 종류의 읽기/쓰기"를 보장할지 지정한다. **MemoryBarrier / BufferMemoryBarrier / ImageMemoryBarrier** 모두 `srcAccessMask`, `dstAccessMask`를 가진다.

- **srcAccessMask**: 배리어 **이전**에 완료되어야 하는 액세스 종류 (쓰기 위주로 지정).
- **dstAccessMask**: 배리어 **이후**에 일어날 수 있는 액세스 종류 (읽기/쓰기).

예:

- `TRANSFER_WRITE` → 전송(복사) 연산에서 리소스에 쓰기.
- `SHADER_READ` → 셰이더가 텍스처/UBO 등 읽기.
- `SHADER_WRITE` → 셰이더에서 쓰기.
- `COLOR_ATTACHMENT_WRITE` → 컬러 어태치먼트 쓰기.
- `DEPTH_STENCIL_READ/WRITE` 등.

스테이지와 짝을 맞추는 게 중요하다. 예: 전송이 끝난 뒤 셰이더가 읽으려면
`srcStage=TRANSFER`, `srcAccessMask=TRANSFER_WRITE`,
`dstStage=FRAGMENT_SHADER`, `dstAccessMask=SHADER_READ` 같은 식으로 맞춘다.

**실제로 배리어가 걸리는 범위**: 스펙(vkCmdPipelineBarrier Description)에서는 다음처럼 정의한다.

> The first synchronization scope is **limited to** operations on the pipeline stages determined by the source stage mask.  
> The first access scope is **limited to** accesses in the pipeline stages … **Within that**, the first access scope only includes the first access scopes defined by elements of the … memory barriers.

요약하면:

1. **동기화 범위 (synchronization scope)**는 먼저 **스테이지 마스크**로 한정된다.
2. 그 안에서 **access scope**는 배리어에 지정한 **access 타입**(`srcAccessMask` / `dstAccessMask`)으로만 한정된다.

따라서 **"지정한 스테이지에서 일어나는, 지정한 액세스 타입"**만 동기화·캐시 제어 대상이 된다(스테이지와 액세스 둘 다 만족하는 연산만 포함).

- **AccessMask에 넣은 종류의 접근만** 그 배리어에 포함되고, AccessMask에 없는 접근 타입은 의존성/캐시 제어에서 빠진다.
- 배리어에 **하나의 메모리 배리어도 지정하지 않으면** access scope는 **완전히 비어 있다**. 즉, 실행 순서(execution dependency)만 보장되고 메모리 가시성은 보장되지 않는다. stage는 기다리지만 cache는 flush/invalidate 되지 않는다는 뜻이다.
- `VkSubpassDependency`(렌더 패스 내 서브패스 간 의존성)도 같은 원리로, `srcAccessMask` / `dstAccessMask`에 있는 접근 타입만 해당 의존성(배리어)에 포함된다.

---

---

## 5. dependencyFlags

- `VK_DEPENDENCY_BY_REGION_BIT`: 픽셀/영역 단위로 의존성(같은 영역만 동기화). 렌더 패스 내부에서 자주 씀.
- `VK_DEPENDENCY_VIEW_LOCAL_BIT` 등: 멀티뷰/렌더 패스에서 사용.
- 0: 전체 파이프라인에 걸친 전역 배리어(가장 강한 동기화).

---

---

## 6. 렌더 패스 내부 배리어

`vkCmdPipelineBarrier`를 렌더 패스 안(`vkCmdBeginRenderPass` ~ `vkCmdEndRenderPass` 사이)에서 호출할 때는 여러 제약이 따른다.

**할 수 있는 것:**
- 같은 서브패스 안에서 `COLOR_ATTACHMENT_OUTPUT` / `DEPTH_STENCIL_*` 관련 동기화
- `VK_DEPENDENCY_BY_REGION_BIT`를 사용한 framebuffer-local 의존성

**할 수 없는 것:**
- 버퍼 메모리 배리어 사용 불가 (`pBufferMemoryBarriers`는 렌더 패스 내부에서 금지)
- 큐 패밀리 소유권 이전 불가 (src와 dst 큐 패밀리가 달라선 안 됨)
- 이미지 레이아웃 전환 불가 (`oldLayout`와 `newLayout`이 같아야 함)
- framebuffer-space가 아닌 스테이지(예: `TRANSFER`, `COMPUTE_SHADER`)는 src/dst로 지정 불가
- 렌더 패스가 `VkRenderPass` 오브젝트로 생성된 경우, 서브패스 셀프 의존성(self-dependency)이 배리어의 superset이어야 함

> 실무적으로는 **렌더 패스 안에서는** 동일한 서브패스 내에서 attachment를 쓰고 읽는 용도로만 제한하고, 복잡한 배리어는 렌더 패스 **밖으로** 빼는 것이 좋다.

---

---

## 7. VK_KHR_synchronization2 (Vulkan 1.3)

Vulkan 1.3에서 core로 승격된 `VK_KHR_synchronization2`는 배리어 API를 더 간결하고 안전하게 개선했다.

### `vkCmdPipelineBarrier2` + `VkDependencyInfo`

레거시 `vkCmdPipelineBarrier`는 인자가 9개라서 실수하기 쉽다. 새 API는 `VkDependencyInfo` 하나로 싼다.

```c
// 레거시 (Vulkan 1.0)
vkCmdPipelineBarrier(cmd,
    VK_PIPELINE_STAGE_TRANSFER_BIT,          // srcStageMask
    VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT,    // dstStageMask
    0,
    0, nullptr,                               // memory barriers
    0, nullptr,                               // buffer barriers
    1, &imageBarrier);                        // image barriers

// Synchronization2 (Vulkan 1.3)
VkDependencyInfo depInfo{};
depInfo.imageMemoryBarrierCount = 1;
depInfo.pImageMemoryBarriers = &imageBarrier2;
vkCmdPipelineBarrier2(cmd, &depInfo);
```

### 달라진 점

| 항목 | 레거시 | Synchronization2 |
|------|--------|-----------------|
| stage/access 마스크 | 32비트 (`VkPipelineStageFlags`) | 64비트 (`VkPipelineStageFlags2`) |
| NONE | 없음 (`TOP_OF_PIPE`로 우회) | `VK_PIPELINE_STAGE_2_NONE`, `VK_ACCESS_2_NONE` |
| stage+access 통합 | 별도 파라미터 | `VkMemoryBarrier2`에서 stage/access를 한 구조체로 |
| 레이아웃 전환 없는 배리어 | 항상 old/new layout 지정 필요 | `oldLayout == newLayout`이면 전환 없음 |
| 복사 계열 | `vkCmdCopyBuffer`, `vkCmdBlitImage` 등 | `*2` 버전 (`vkCmdCopyBuffer2`, `vkCmdBlitImage2` 등) |

**64비트 마스크** 덕분에 더 이상 비트가 부족하지 않아 확장 스테이지를 32비트에 억지로 끼워넣지 않아도 된다.

**NONE 마스크**는 "아무 스테이지도 기다리지 않는다"를 명시적으로 표현할 수 있어, 예전처럼 `TOP_OF_PIPE`를 src로 써서 우회할 필요가 없어졌다.

### Stage와 Access가 한 구조체로

레거시는 stage와 access를 별도 배열로 전달하지만, synchronization2는 `VkMemoryBarrier2` / `VkBufferMemoryBarrier2` / `VkImageMemoryBarrier2` 안에 **stage와 access를 함께 넣는다.**

```c
// 레거시
VkImageMemoryBarrier barrier{};
barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
barrier.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
// stage는 별도로: srcStageMask / dstStageMask

// Synchronization2
VkImageMemoryBarrier2 barrier2{};
barrier2.srcStageMask = VK_PIPELINE_STAGE_2_TRANSFER_BIT;
barrier2.srcAccessMask = VK_ACCESS_2_TRANSFER_WRITE_BIT;
barrier2.dstStageMask = VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT;
barrier2.dstAccessMask = VK_ACCESS_2_SHADER_SAMPLED_READ_BIT;
```

이렇게 하면 **배리어 단위로 stage와 access가 항상 함께 묶여서** 실수로 stage-access 쌍이 어긋날 위험이 줄어든다.

> 엔진이 Vulkan 1.3을 타겟으로 한다면, 새로 작성하는 배리어 코드는 synchronization2 스타일로 통일하는 것이 좋다. 레거시는 `1.0`과의 하위 호환성 유지용으로만 남긴다.

---

### stage와 access는 반드시 짝을 맞춰라

`TRANSFER` stage와 `TRANSFER_WRITE` access, `FRAGMENT_SHADER` stage와 `SHADER_READ` access는 항상 쌍으로 지정한다. 스테이지 마스크가 지정하는 스테이지에서 **발생할 수 없는** access 타입을 넣으면 validation error다.

### ALL_COMMANDS / ALL_GRAPHICS는 느리다

`VK_PIPELINE_STAGE_ALL_COMMANDS_BIT`나 `ALL_GRAPHICS_BIT`는 디버깅용으로만 쓰고, 실제 코드에서는 **가능한 좁은 스테이지 범위**를 지정하는 것이 성능에 좋다.

### 메모리 배리어 없이 stage만 기다리기

memory barrier 수를 0으로 주고, 어떤 `pMemoryBarriers` / `pBufferMemoryBarriers` / `pImageMemoryBarriers`도 비우면, **execution dependency만** 생성된다. 메모리 가시성 보장은 없으므로, 캐시가 필요한 상황이라면 반드시 적절한 access mask도 함께 지정해야 한다.

---

## 6. 뭐부터 써야 하지? — 실전 선택 가이드

처음 Vulkan을 배우면 "어떤 동기화를 써야 하지?"가 가장 어려운 질문이다. 다음은 자주 묻는 상황별 정리다:

- **프레임 단위로 CPU가 GPU 완료를 확인** → Fence 하나면 충분하다
- **렌더링 결과 → 프레젠테이션** → Binary Semaphore (거의 모든 Vulkan 앱의 기본 패턴)
- **이미지 레이아웃 바꾸기** (예: 렌더 타깃 → 셰이더 읽기) → Pipeline Barrier
- **같은 큐 안에서 복잡한 의존성** → Event로 세밀하게, 아니면 Pipeline Barrier로 간단하게

초보자는 일단 **Fence + Binary Semaphore + Pipeline Barrier** 세 가지만 잘 써도 대부분 해결된다. Event는 성능 최적화가 필요할 때 고려하면 된다.

---

---

## 7. 비교 한눈에

| 프리미티브 | 동기화 범위 | 세밀도 |
|-----------|------------|--------|
| **Fence** | Host (CPU) ↔ GPU (Queue) | 큐 단위 (coarse) |
| **Semaphore** | GPU (Queue A) ↔ GPU (Queue B) | 큐 단위 |
| **Event** | GPU (동일 큐 내) | 스테이지 (fine) |
| **Pipeline Barrier** | GPU (동일 큐 내) | 스테이지 + 액세스 (fine) |

**선택 가이드:**

| 상황 | 사용할 것 |
|------|----------|
| "이 커맨드 버퍼가 끝날 때까지 CPU가 기다려야 함" | **Fence** |
| "이 큐의 작업이 끝나야 저 큐가 시작됨" (큐 간) | **Semaphore** (binary) |
| "작업 A의 일부가 끝난 후 작업 B를 시작" (동일 큐, 복잡한 흐름) | **Event** |
| "이미지 레이아웃을 바꾸고, 셰이더가 읽을 수 있게 해야 함" | **Pipeline Barrier** |
| "여러 큐에 걸친 복잡한 의존성을 값으로 관리" | **Timeline Semaphore** |
| "다음 프레임의 커맨드 버퍼가 이전 프레임 리소스를 덮어써도 됨" | **Fence (프레임당 하나)** |

---

---

## 8. 타임라인 예제 (Triple Buffering + Swapchain)

```cmdstack
CPU: Frame N 제출 → Fence[N] 대기 → Frame N+1 제출 → ...
---
GPU: Frame N → Frame N+1 → Frame N+2 (파이프라인)
Frame N: 렌더링 → 프레젠트
Frame N+1: 렌더링 → 프레젠트
---
Sem: imgAvail[N], renderDone[N], ...
Fence: f[N]↑, f[N+1]↑, ...
```

- `vkAcquireNextImageKHR` → `imageAvailable` semaphore signal
- 렌더링 커맨드 제출 → `renderFinished` semaphore signal + `fence` signal
- `vkQueuePresentKHR` → `renderFinished` semaphore wait
- CPU는 `fence`로 "프레임 N의 작업이 끝났음"을 확인하고 리소스 재활용

---

## 배리어 최적화 팁

배리어는 **필요한 만큼만** 쓴다. 과도한 배리어는 GPU 스톨을 만든다.

```cmdstack
최적화 원칙
---
필요한 최소 스테이지만 포함
---
VK_DEPENDENCY_BY_REGION_BIT ← 영역 한정 배리어
---
Render Pass 내부는 framebuffer-space 스테이지만
---
불필요한 레이아웃 전환 최소화
```

- **`vkCmdPipelineBarrier`**: `srcStageMask` / `dstStageMask`를 가능한 좁게
- **Synchronization2 (1.3)**: `VkMemoryBarrier2`, `VkDependencyInfo`로 세밀한 접근 타입 지정

렌더 패스 **내부**에서 framebuffer-space 스테이지를 쓸 때는 `VK_DEPENDENCY_BY_REGION_BIT`이 필수에 가깝다.

---
