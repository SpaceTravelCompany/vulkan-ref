---
title: 멀티스레딩
slug: thread-safety
---

## 소개

Vulkan은 **멀티스레딩을 염두에 두고 설계된 API**다. OpenGL이 단일 스레드에 종속적이었던 반면, Vulkan은 애플리케이션이 **명시적으로 스레드 안전성을 관리하게 한다**.

> **왜 이렇게 복잡할까?** OpenGL은 드라이버가 내부적으로 락을 걸어서 안전했지만, 그 비용이 성능 저하로 이어졌다. Vulkan은 "락 비용을 제거하고, 동기화는 앱이 책임져"라는 설계 철학이다. 한번 익혀두면 멀티코어를 최대한 활용할 수 있다.

"기본적으로 안전하지 않다"는 점을 이해하고, Vulkan이 요구하는 동기화 규칙만 지키면 여러 스레드에서 안전하게 사용할 수 있다.

> **용어 정리**
> - **외부 동기화(External Synchronization)**: Vulkan이 내부적으로 락을 안 걸 테니, 호출하는 쪽에서 mutex 등으로 보호하라는 뜻
> - **Command Pool**: 커맨드 버퍼를 할당하는 "공장". 스레드별로 분리해야 안전하다
> - **Frame-in-Flight**: 아직 GPU가 작업 중인 프레임과 별개로, 다음 프레임 리소스를 따로 두는 기법

---

## 1. Vulkan의 스레딩 원칙

Vulkan의 스레딩 동작은 스펙(Chapter 3.6)에 명확히 정의되어 있다:

> Vulkan is intended to provide scalable multithreaded access to graphics hardware. The threading model is **explicitly application-controlled**, meaning that the application is responsible for synchronizing access to Vulkan objects when required.

즉, Vulkan은 **"외부 동기화(external synchronization)"** 가 필요한 객체와 그렇지 않은 객체를 구분해 놓았다.

**기본 원칙:**
- **Command buffer recording**: 여러 스레드에서 **동시에 가능** (단, 각 커맨드 버퍼는 서로 다른 커맨드 풀에서 할당)
- **VkDevice / VkQueue**: 스레드 안전하지 않음 → **호출 측에서 락 필요**
- **Descriptor pool / Fence / Semaphore 등**: 스펙에 "externally synchronized"라고 명시된 객체는 멀티스레드 접근에 락 필요

---

## 2. Externally Synchronized Parameters

스펙(Chapter 3.6)은 "Host access to X must be externally synchronized" 형식으로 명시한다.

**외부 동기화가 필요한 주요 객체들:**

| 객체 | 비고 |
|------|------|
| `VkDevice` | `vkDestroyDevice` 등 |
| `VkQueue` | `vkQueueSubmit`, `vkQueuePresentKHR`, `vkQueueWaitIdle` |
| `VkCommandPool` | `vkAllocateCommandBuffers`, `vkFreeCommandBuffers`, `vkResetCommandPool` |
| `VkDescriptorPool` | `vkAllocateDescriptorSets`, `vkFreeDescriptorSets`, `vkResetDescriptorPool` |
| `VkFence` | `vkDestroyFence`, `vkResetFences` (같은 fence를 여러 스레드에서 리셋 금지) |
| `VkSemaphore` | `vkDestroySemaphore`, signal/wait pending 중 수정 금지 |
| `VkEvent` | `vkSetEvent`, `vkResetEvent` |
| `VkBuffer` / `VkImage` | 생성/파괴 시 |
| `VkSwapchainKHR` | `vkAcquireNextImageKHR`, `vkQueuePresentKHR` 호출 전 |

**동기화가 필요하지 않은 것들:**
- `vkCreate*` / `vkDestroy*` 호출 자체는 같은 타입의 다른 인스턴스에 대해 별도 락이 필요하지 않음 (단일 객체만 외부 동기화)
- `VkInstance`는 안전 (`vkDestroyInstance` 제외)
- `VkPhysicalDevice`는 읽기 전용이므로 안전

---

## 3. 멀티스레드 커맨드 버퍼 기록 (가장 중요한 최적화)

Vulkan의 핵심 장점 중 하나는 **여러 스레드가 동시에 커맨드 버퍼를 기록**할 수 있다는 점이다.

```c
// 스레드 1: 그림자 맵 렌더링
void Thread_ShadowMaps() {
    VkCommandBuffer cmd = shadowCmdPools[threadId]->Allocate();
    vkBeginCommandBuffer(cmd, ...);
    // ... shadow map draw calls
    vkEndCommandBuffer(cmd);
}

// 스레드 2: GBuffer 렌더링
void Thread_GBuffer() {
    VkCommandBuffer cmd = gbufferCmdPools[threadId]->Allocate();
    vkBeginCommandBuffer(cmd, ...);
    // ... gbuffer draw calls
    vkEndCommandBuffer(cmd);
}

// 스레드 3: UI 렌더링
void Thread_UI() {
    VkCommandBuffer cmd = uiCmdPools[threadId]->Allocate();
    vkBeginCommandBuffer(cmd, ...);
    // ... ui draw calls
    vkEndCommandBuffer(cmd);
}

// 메인 스레드: 모든 커맨드 버퍼를 하나로 묶어서 제출
std::vector<VkCommandBuffer> cmds = { shadowCmd, gbufferCmd, uiCmd };
vkQueueSubmit(queue, 1, &submitWithAll, fence);
```

**핵심 규칙:**
1. **각 스레드는 별도의 `VkCommandPool`을 사용해야 함** (CommandPool 자체는 externally synchronized)
2. CommandPool은 **해당 스레드가 사용할 큐 패밀리와 호환되어야 함**
3. 각 커맨드 버퍼는 **독립적인 리소스(버퍼, 이미지)를 수정**해야 동시성 문제 없음
4. 같은 리소스를 여러 스레드가 동시에 수정해야 한다면, CPU 측에서 barrier/lock으로 보호

**커맨드 풀별 스레드 관리는 성능에도 이점이 있다.** 드라이버가 각 풀에 대해 내부 메모리 할당자를 별도로 관리할 수 있기 때문이다.

---

## 4. Queue 제출은 단일 스레드 (또는 락)

`vkQueueSubmit`과 `vkQueuePresentKHR`은 **같은 큐에 대해 외부 동기화가 필요**하다. 즉, 여러 스레드에서 동시에 같은 큐에 제출할 수 없다.

> 큐는 GPU에 명령을 보내는 "파이프"다. 여러 스레드가 동시에 파이프에 명령을 밀어넣으면 순서가 꼬인다. 보통은 **제출 전담 스레드**를 하나 두는 방식으로 해결한다.

```c
// Bad: 두 스레드가 동시에 같은 큐에 submit
Thread A: vkQueueSubmit(queue, ...);  // ← race condition
Thread B: vkQueueSubmit(queue, ...);  // ← race condition

// Good: mutex로 보호
std::mutex queueMutex;
Thread A: { std::lock_guard lk(queueMutex); vkQueueSubmit(queue, ...); }
Thread B: { std::lock_guard lk(queueMutex); vkQueueSubmit(queue, ...); }
```

또는 **dedicated submit thread**를 두고, 다른 스레드들은 커맨드 버퍼 기록만 담당하게 하는 패턴이 일반적이다.

```flowchart
flowchart TD
  A["Thread 1 → cmd buffer A"]
  B["Thread 2 → cmd buffer B"]
  C["Thread 3 → cmd buffer C"]
  D["Submit Thread → vkQueueSubmit"]
  E["queue mutex로 보호"]
  A --> D
  B --> D
  C --> D
  D --> E
```

---

## 5. Frame-in-Flight와 리소스 이중화

멀티스레드 환경에서 리소스 경쟁을 피하기 위해 **더블/트리플 버퍼링**을 사용한다.

> **용도** 프레임 N이 아직 GPU에서 실행 중인데, CPU가 다음 프레임(N+1)의 준비를 하려면 같은 리소스를 건드려야 한다. Frame-in-Flight 패턴은 프레임마다 독립된 리소스를 만들어서 이런 충돌을 피한다.

```c
struct FrameData {
    VkCommandPool cmdPool;
    VkCommandBuffer cmdBuffer;
    VkFence inFlightFence;
    VkSemaphore imageAvailable;
    VkSemaphore renderFinished;
    // per-frame descriptor pool
    VkDescriptorPool descPool;
};

FrameData frames[MAX_FRAMES_IN_FLIGHT];
int currentFrame = 0;
```

매 프레임마다 `currentFrame` 인덱스를 바꿔가며 사용하면, 한 프레임이 아직 GPU에서 실행 중이어도 다음 프레임의 리소스는 간섭받지 않는다.

---

## 6. Descriptor Pool에도 동기화 필요

`VkDescriptorPool`은 **externally synchronized**다. 즉, 같은 풀에서 여러 스레드가 동시에 descriptor set을 할당/해제할 수 없다.

해결책:
1. **스레드별 전용 descriptor pool** 사용 (가장 흔함)
2. **프레임별 descriptor pool** + 락
3. 전체 pool에 mutex 사용 (덜 효율적)

---

## 7. Host Synchronization (스펙이 명시하는 규칙)

모든 Vulkan 명령어의 스펙에는 `Host Synchronization` 섹션이 있다. 예를 들어 `vkQueueSubmit`의 경우:

```
Host Synchronization
• Host access to queue must be externally synchronized
• Host access to commandBuffer must be externally synchronized
```

`vkCmdPipelineBarrier`의 경우:

```
Host Synchronization
• Host access to commandBuffer must be externally synchronized
• Host access to the VkCommandPool that commandBuffer was allocated from
  must be externally synchronized
```

---

### 7.1. "externally synchronized"가 무슨 뜻인가?

"Externally synchronized"는 **Vulkan이 내부적으로 락을 걸지 않으니까, 호출하는 쪽에서 알아서 동기화하라**는 뜻이다.

쉽게 말하면:
- Vulkan은 성능을 위해 대부분의 객체에 **mutex가 내장되어 있지 않음**
- 같은 객체를 **동시에 두 스레드가 건드리면 data race 발생**
- 그 책임은 전적으로 애플리케이션에 있음

```c
// Bad: 같은 commandBuffer를 두 스레드에서 동시에 사용
// Thread A
vkCmdPipelineBarrier(cmdBuf, ...);

// Thread B (동시 실행)
vkCmdPipelineBarrier(cmdBuf, ...);  // ← data race! 💥

// Good: 뮤텍스로 보호
std::mutex mtx;
// Thread A
{ std::lock_guard lk(mtx); vkCmdPipelineBarrier(cmdBuf, ...); }
// Thread B
{ std::lock_guard lk(mtx); vkCmdPipelineBarrier(cmdBuf, ...); }
```

---

### 7.2. 왜 commandBuffer **와** commandPool 둘 다 동기화해야 하는가?

`vkCmdPipelineBarrier`의 Host Synchronization은 두 가지를 요구한다:

1. `Host access to commandBuffer must be externally synchronized`
   - 같은 `VkCommandBuffer`를 동시에 두 스레드에서 기록/제출하면 안 됨
   - 즉, **커맨드 버퍼 하나는 한 번에 한 스레드만** 사용

2. `Host access to the VkCommandPool that commandBuffer was allocated from must be externally synchronized`
   - 커맨드 버퍼를 할당한 **VkCommandPool도 동시에 건드리면 안 됨**
   - 이유 드라이버가 내부적으로 CommandPool 단위로 상태를 관리함. 같은 Pool에서 할당된 다른 커맨드 버퍼가 다른 스레드에서 기록 중이어도 영향을 줄 수 있음

**즉, 같은 CommandPool에서 할당된 모든 커맨드 버퍼는 동시에 사용할 수 없다.**

```c
// Bad: 같은 pool에서 할당된 cmdA와 cmdB를 동시에 기록
VkCommandPool sharedPool;
VkCommandBuffer cmdA, cmdB;  // 같은 pool에서 할당됨

// Thread A
vkBeginCommandBuffer(cmdA, ...);  // sharedPool 접근

// Thread B (동시)
vkBeginCommandBuffer(cmdB, ...);  // sharedPool 접근 → data race! 💥

// Good: pool 자체를 스레드별로 분리
VkCommandPool poolA;  // Thread A 전용
VkCommandPool poolB;  // Thread B 전용
VkCommandBuffer cmdA, cmdB;  // 각각 다른 pool에서 할당

// Thread A
vkBeginCommandBuffer(cmdA, ...);  // poolA만 접근 ✅

// Thread B (동시)
vkBeginCommandBuffer(cmdB, ...);  // poolB만 접근 ✅
```

**명심할 것:**
- `vkBeginCommandBuffer` / `vkEndCommandBuffer` / `vkResetCommandBuffer` 등도 **암시적으로 commandPool에 접근**하므로 동시성 제한이 똑같이 적용됨
- 즉, 커맨드 버퍼를 기록하는 **모든 명령어**는 같은 pool의 다른 커맨드 버퍼와 동시에 사용할 수 없음

---

### 7.3. 실제로 위반하면 어떻게 되는가?

"externally synchronized"를 위반하면 스펙 상 **동작이 정의되지 않음(undefined behavior)**이다.

| 현상 | 설명 |
|------|------|
| **데이터 손상** | 드라이버 내부 버퍼가 꼬여서 GPU 크래시 (VK_ERROR_DEVICE_LOST) |
| **Validation Error** | Validation Layer가 잡아주는 경우: `VUID-vkCmdPipelineBarrier-commandBuffer-cmdpool` |
| **미묘한 버그** | 가끔만 크래시 나서 디버깅이 지옥이 됨 (heisenbug) |

Validation Layer가 "이건 동기화 문제야"라고 친절히 알려주기도 하지만, 모든 경우를 잡아주진 않는다.

---

### 7.4. fence/semaphore도 동기화가 필요하다

한 가지 자주 실수하는 부분: 같은 `VkFence`를 CPU 쪽에서 여러 스레드가 동시에 `vkResetFences` / `vkGetFenceStatus` 하면 data race다.

> **이유** Fence는 GPU 작업 완료 신호를 관리하는 객체다. 한 스레드가 "완료 확인 → 리셋"을 하는 동안 다른 스레드가 제출하면, Fence 상태가 꼬여서 CPU가 영원히 기다리거나 잘못된 시점에 진행될 수 있다.

```c
// Bad: 같은 fence를 두 스레드에서 리셋
// Thread A: fence 확인 후 리셋
vkWaitForFences(dev, 1, &fence, VK_TRUE, UINT64_MAX);
vkResetFences(dev, 1, &fence);

// Thread B (동시): 제출
vkQueueSubmit(queue, 1, &submit, fence);  // ← fence가 리셋되기 전/후 타이밍 따라 data race

// Good: fence는 한 스레드에서만 관리
// Thread A (fence 관리 전담)
vkWaitForFences(dev, 1, &fence, VK_TRUE, UINT64_MAX);
vkResetFences(dev, 1, &fence);
// Thread B에 "fence ready" 알림

// Thread B (fence ready 후 제출)
vkQueueSubmit(queue, 1, &submit, fence);
```

---

### 7.5. Implicit Externally Synchronized Parameters (스펙 발췌)

스펙은 "명시적" 파라미터 외에도 "암시적"으로 동기화가 필요한 객체들을 정의한다. 대표적인 예가 "commandBuffer를 동기화하면 그 commandPool도 자동으로 동기화해야 한다"는 규칙이다.

> **초보자 팁**: 이 표를 외울 필요는 없다. 다만 "커맨드 버퍼를 건드리면 그 풀도 같이 보호해야 한다"는 원칙만 기억하면 된다. Validation Layer가 위반 시 알려준다.

| 명령어 | 암시적 동기화 대상 |
|--------|------------------|
| `vkBeginCommandBuffer` | 커맨드 버퍼를 할당한 `VkCommandPool` |
| `vkEndCommandBuffer` | 커맨드 버퍼를 할당한 `VkCommandPool` |
| `vkResetCommandBuffer` | 커맨드 버퍼를 할당한 `VkCommandPool` |
| `vkCmdCopyBuffer` | 커맨드 버퍼를 할당한 `VkCommandPool` |
| `vkCmdPipelineBarrier` | 커맨드 버퍼를 할당한 `VkCommandPool` |
| `vkUpdateDescriptorSets` | dstSet의 `VkDescriptorPool` |
| `vkDestroyDevice` | device에서 생성된 모든 `VkQueue` |

---

## 8. 실전 패턴 요약

멀티스레딩을 처음 적용한다면 다음 패턴부터 시작하는 것을 추천한다.

> **단계별 접근**:
> 1. 먼저 단일 스레드로 정상 동작 확인
> 2. Validation Layer로 동기화 문제 없는지 검증
> 3. 커맨드 버퍼 기록 부분을 스레드로 분리 (각 스레드별 CommandPool)
> 4. 제출은 단일 스레드 전담
> 5. Frame-in-Flight로 리소스 충돌 방지

**추천 패턴 (엔진 수준):**

```
메인 스레드:
  - VkQueue submit 전담 (또는 lock으로 보호)
  - 프레임 리소스 관리 (per-frame pool 순환)
  - swapchain acquire/present

작업 스레드 (n개):
  - 각각 전용 VkCommandPool 소유
  - 커맨드 버퍼 기록 전담
  - 각자 별도의 VkDescriptorPool 사용
  - 필요시 secondary command buffer 사용

설계 원칙:
  - "공유하는 객체에는 락, 전용 객체는 락 불필요"
  - VkCommandPool / VkDescriptorPool / VkPipelineCache 등은 스레드별로 분리
  - VkQueue / VkFence 등은 락으로 보호
```
