---
title: 멀티스레딩
slug: thread-safety
---

## 소개

Vulkan은 멀티스레드 병렬 처리를 핵심 목표로 설계됐다. 레거시 API와 달리 애플리케이션이 스레드 동기화를 직접 관리한다.

> **설계 배경**: 과거 그래픽스 API는 드라이버 내부에서 자체적으로 뮤텍스 락을 걸어 스레드 안전성을 보장했으나, 이는 상당한 동기화 오버헤드를 초래했다. Vulkan은 대부분의 객체에서 드라이버 레벨 암묵적 락을 제거하고 동기화 책임을 애플리케이션에 위임한다. 단, 일부 객체(`VkPipelineCache` 등)는 스펙상 "internally synchronized"로 명시되어 동시 접근이 안전하다.

애플리케이션은 externally synchronized로 표시된 객체에 대해 호스트 뮤텍스 등으로 동시 접근을 제어해야 한다.

> **용어 정리**
> - **외부 동기화(External Synchronization)**: 드라이버 차원의 내부 잠금이 제공되지 않으므로, 애플리케이션이 호스트 뮤텍스(`std::mutex` 등)를 통해 동시 접근을 직접 제어해야 하는 규칙.
> - **Command Pool**: 커맨드 버퍼의 메모리를 할당하고 관리하는 풀 객체. 풀 자체에 대한 접근이 외부 동기화 대상이므로 스레드별로 독립된 풀을 생성해야 한다.
> - **Frame-in-Flight**: GPU가 이전 프레임의 작업을 처리하는 동안 CPU가 다음 프레임의 커맨드를 중첩하여 준비할 수 있도록 프레임별 리소스를 이중/삼중으로 분리하여 운용하는 기법.

---

## 1. Vulkan의 스레딩 원칙

Vulkan의 스레딩 동작 규격은 공식 명세서(Chapter 3.6)에 다음과 같이 명시되어 있다:

> "Vulkan is intended to provide scalable multithreaded access to graphics hardware. The threading model is explicitly application-controlled, meaning that the application is responsible for synchronizing access to Vulkan objects when required."

즉, Vulkan은 **"외부 동기화(External Synchronization)"**가 필요한 객체/매개변수와 다중 스레드에서 동시 접근이 허용되는 객체를 명확히 구분한다.

**기본 원칙:**
- **커맨드 버퍼 병렬 기록(Recording)**: 여러 스레드에서 **동시에 기록 가능**하다. 단, 각 커맨드 버퍼는 서로 다른 커맨드 풀(`VkCommandPool`)에서 할당되어야 한다.
- **큐 제출(`VkQueue`)**: 스레드 안전하지 않음 → 동일 큐에 대한 제출은 **호스트 레벨의 상호 배제(Lock) 필요**.
- **디스크립터 풀 및 동기화 객체**: 명세서에 "Host access must be externally synchronized"로 명시된 객체는 멀티스레드 접근 시 동기화 보호 필수.

---

## 2. 외부 동기화 대상 객체 (Externally Synchronized)

Vulkan 명세서는 개별 API마다 매개변수 수준에서 외부 동기화 필요 여부를 정의한다.

**동시 접근 시 애플리케이션 차원의 락이 필요한 주요 대상:**

| 객체 타입 | 외부 동기화가 필요한 대표적 함수 |
|-----------|----------------------------------|
| `VkDevice` | `vkDestroyDevice` 등 소멸 함수 |
| `VkQueue` | `vkQueueSubmit`, `vkQueuePresentKHR`, `vkQueueWaitIdle` |
| `VkCommandPool` | `vkAllocateCommandBuffers`, `vkFreeCommandBuffers`, `vkResetCommandPool`, `vkTrimCommandPool` |
| `VkDescriptorPool` | `vkAllocateDescriptorSets`, `vkFreeDescriptorSets`, `vkResetDescriptorPool` |
| `VkFence` | `vkDestroyFence`, `vkResetFences` (동일 펜스에 대한 동시 리셋/수정 금지) |
| `VkSemaphore` | `vkDestroySemaphore` (신호/대기 대기 상태에서의 수정 금지) |
| `VkEvent` | `vkSetEvent`, `vkResetEvent` |
| `VkSwapchainKHR` | `vkAcquireNextImageKHR`, `vkQueuePresentKHR` |

**다중 스레드 동시 접근이 안전한 작업:**
- 상호 독립적인 객체의 `vkCreate*` / `vkDestroy*` 호출 (예: 서로 다른 스레드에서 별개의 버퍼 생성)
- `VkInstance`의 읽기 작업 (`vkDestroyInstance` 제외)
- `VkPhysicalDevice`에 대한 모든 질의 함수 (완전한 불변 읽기 전용 객체)
- 파이프라인 바인딩 정보가 불변인 객체들의 읽기 참조

---

## 3. 멀티스레드 커맨드 버퍼 기록

Vulkan의 핵심 성능 이점 중 하나는 **다중 CPU 코어에서 병렬로 커맨드 버퍼를 기록**할 수 있다는 점이다.

```c
// 워커 스레드 1: 그림자 맵 패스 렌더링
void Thread_ShadowPass(uint32_t threadIndex) {
    VkCommandBuffer cmd = shadowCmdBuffers[threadIndex];
    // 해당 스레드 전용 풀에서 할당된 커맨드 버퍼 사용
    vkBeginCommandBuffer(cmd, &beginInfo);
    // ... 그림자 맵 드로우 호출 기록 ...
    vkEndCommandBuffer(cmd);
}

// 워커 스레드 2: G-Buffer 패스 렌더링
void Thread_GBufferPass(uint32_t threadIndex) {
    VkCommandBuffer cmd = gbufferCmdBuffers[threadIndex];
    vkBeginCommandBuffer(cmd, &beginInfo);
    // ... G-Buffer 드로우 호출 기록 ...
    vkEndCommandBuffer(cmd);
}

// 워커 스레드 3: UI 렌더링
void Thread_UIPass(uint32_t threadIndex) {
    VkCommandBuffer cmd = uiCmdBuffers[threadIndex];
    vkBeginCommandBuffer(cmd, &beginInfo);
    // ... UI 드로우 호출 기록 ...
    vkEndCommandBuffer(cmd);
}

// 메인 스레드: 각 스레드가 기록 완료한 커맨드 버퍼들을 취합하여 단일 큐 제출
void MainThread_Submit() {
    VkCommandBuffer submitCmds[] = { shadowCmd, gbufferCmd, uiCmd };
    VkSubmitInfo submitInfo{};
    submitInfo.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    submitInfo.commandBufferCount = 3;
    submitInfo.pCommandBuffers = submitCmds;

    vkQueueSubmit(graphicsQueue, 1, &submitInfo, frameFence);
}
```

**스레드 분리 핵심 규칙:**
1. **스레드별 독립 `VkCommandPool` 운용**: 각 스레드는 반드시 자신만의 전용 커맨드 풀을 소유해야 한다.
2. **큐 패밀리 호환성**: 커맨드 풀 생성 시 해당 스레드가 실행할 대상 큐 패밀리 인덱스와 일치해야 한다.
3. **독립 리소스 접근**: 각 커맨드 버퍼가 수정하는 동적 버퍼나 텍스처 영역이 서로 겹치지 않도록 분리해야 한다.

스레드마다 커맨드 풀을 분리하면 드라이버 내부의 메모리 할당자가 락 없이 독립적으로 동작하므로 멀티스레드 확장성이 극대화된다.

---

## 4. 큐 제출 동기화 (단일 스레드 제출 또는 뮤텍스)

`vkQueueSubmit`과 `vkQueuePresentKHR`는 **동일한 `VkQueue`에 대해 외부 동기화를 요구**한다. 즉, 여러 스레드에서 동일한 큐 핸들을 대상으로 동시에 제출 함수를 호출할 수 없다.

> **큐 제출 동기화 원칙**: `VkQueue`는 커맨드 버퍼를 GPU 스케줄러로 전달하는 하드웨어 큐이다. 동일 큐에 대해 여러 스레드가 동시에 `vkQueueSubmit` 또는 `vkQueuePresentKHR`를 호출하면 경쟁 상태가 발생하므로, 호스트 레벨의 뮤텍스로 보호하거나 **제출 전담 스레드(Dedicated Submit Thread)**를 구성하여 순차 제출해야 한다.

```c
// [잘못된 예] 뮤텍스 없이 두 스레드가 동일 큐에 동시 제출 -> 데이터 레이스 발생
// 스레드 A: vkQueueSubmit(graphicsQueue, ...);
// 스레드 B: vkQueueSubmit(graphicsQueue, ...);

// [올바른 예 1] 호스트 뮤텍스를 통한 상호 배제
std::mutex queueMutex;

void SubmitSafely(VkQueue queue, const VkSubmitInfo& info, VkFence fence) {
    std::lock_guard<std::mutex> lock(queueMutex);
    vkQueueSubmit(queue, 1, &info, fence);
}
```

일반적으로 고성능 엔진에서는 작업 스레드들이 커맨드 버퍼 기록을 마치면 메인 스레드나 **제출 전담 스레드**로 핸들을 넘겨 일괄 제출하는 파이프라인 구조를 적용한다.

```flowchart
flowchart TD
  A["워커 스레드 1: Command Buffer A 기록"]
  B["워커 스레드 2: Command Buffer B 기록"]
  C["워커 스레드 3: Command Buffer C 기록"]
  D["제출 전담 스레드 (큐 뮤텍스 또는 단일 스레드 소유권)"]
  E(["vkQueueSubmit 일괄 호출"])
  A --> D
  B --> D
  C --> D
  D --> E
```

---

## 5. Frame-in-Flight와 리소스 이중화

CPU가 다음 프레임(Frame N+1)의 데이터를 준비하는 동안 GPU는 이전 프레임(Frame N)을 실행한다. 이 과정에서 리소스 경합을 방지하기 위해 **프레임별 리소스 다중화(Frame-in-Flight)**를 구성한다.

> **리소스 충돌 방지**: GPU가 프레임 N을 렌더링하는 동안 CPU가 프레임 N+1의 균일 버퍼나 커맨드 버퍼를 갱신하려면 동일 리소스에 대한 데이터 레이스가 발생한다. Frame-in-Flight 구조는 프레임마다 독립적인 리소스 세트를 할당하여 이러한 동시성 충돌을 방지한다.

```c
struct PerFrameResource {
    VkCommandPool   commandPool;
    VkCommandBuffer commandBuffer;
    VkDescriptorPool descriptorPool;
    VkFence         inFlightFence;
    VkSemaphore     imageAvailableSemaphore;
    VkSemaphore     renderFinishedSemaphore;
    VkBuffer        uniformBuffer;
    void*           mappedUniformMemory;
};

constexpr uint32_t MAX_FRAMES_IN_FLIGHT = 2; // 더블 버퍼링
PerFrameResource frameResources[MAX_FRAMES_IN_FLIGHT];
uint32_t currentFrameIndex = 0;
```

프레임 루프마다 `currentFrameIndex`를 순환하며 `vkWaitForFences`로 해당 프레임의 GPU 작업 완료를 확인한 뒤 리소스를 재사용한다.

---

## 6. Descriptor Pool 스레드 분리 전략

`VkDescriptorPool`은 **외부 동기화 대상**이다. 즉, 동일한 풀 객체에 대해 여러 스레드가 동시에 `vkAllocateDescriptorSets` 또는 `vkFreeDescriptorSets`를 호출할 수 없다.

**실무 권장 해결 전략:**
1. **스레드별 전용 디스크립터 풀 (가장 권장)**: 각 워커 스레드가 전용 풀을 소유하여 락 경합 없이 디스크립터 세트를 고속 할당.
2. **프레임 단위 디스크립터 풀 + 일괄 리셋**: 프레임마다 풀을 통째로 `vkResetDescriptorPool`로 재사용하여 동적 할당 비용 제거.
3. **글로벌 풀에 뮤텍스 적용**: 구현이 단순하지만 동시 할당 시 스레드 병목 유발.

---

## 7. 호스트 동기화 명세 (Host Synchronization)

Vulkan 공식 명세서의 각 함수 항목에는 `Host Synchronization` 규칙이 명시되어 있다.

```
Host Synchronization (vkCmdPipelineBarrier 예시):
• Host access to commandBuffer must be externally synchronized
• Host access to the VkCommandPool that commandBuffer was allocated from
  must be externally synchronized
```

### 7.1. "Externally Synchronized"의 정확한 의미

"외부 동기화"란 Vulkan 런타임이 내부 뮤텍스를 사용하지 않으므로, 호출 측(애플리케이션)이 호스트 동기화 프리미티브(예: `std::mutex`)를 통해 동시 접근을 완전히 상호 배제해야 함을 의미한다.

- 규격을 준수하지 않고 동일 객체에 다중 스레드가 동시 접근하면 **데이터 레이스(Data Race)**가 발생한다.
- 데이터 레이스는 드라이버 상태 손상, GPU 크래시(`VK_ERROR_DEVICE_LOST`), 또는 간헐적인 메모리 오염을 유발한다.

### 7.2. CommandBuffer와 CommandPool을 함께 동기화해야 하는 이유

드라이버는 커맨드 풀 단위로 내부 메모리 할당자 및 서브할당 상태를 관리한다. 따라서 동일한 풀에서 할당된 서로 다른 커맨드 버퍼라 하더라도, 여러 스레드에서 동시에 기록(`vkBeginCommandBuffer`, `vkCmd*`, `vkEndCommandBuffer`)하면 풀의 내부 상태에 동시 접근하게 되어 데이터 레이스가 발생한다.

**따라서 같은 `VkCommandPool`에서 할당된 커맨드 버퍼들은 서로 다른 스레드에서 동시에 기록할 수 없다.** 스레드 병렬 기록을 구현하려면 반드시 풀 자체를 스레드별로 분리해야 한다.

### 7.3. Fence 및 Semaphore 조작 시 주의점

동일한 `VkFence` 핸들에 대해 한 스레드가 `vkResetFences`를 호출하는 도중, 다른 스레드가 해당 펜스를 `vkQueueSubmit`의 인자로 전달하면 호스트 레이스가 발생한다. (`vkWaitForFences`/`vkGetFenceStatus`는 extern-sync 대상이 아니므로 동시 호출이 안전하다.) 펜스의 상태 전이(`vkResetFences`, `vkQueueSubmit`)는 단일 스레드에서 순차적으로 관리해야 한다.

### 7.4. 암시적 외부 동기화 대상 (Implicit Externally Synchronized)

| API 함수 | 암시적 외부 동기화 대상 객체 |
|----------|----------------------------|
| `vkBeginCommandBuffer` | 대상 커맨드 버퍼를 할당한 상위 `VkCommandPool` |
| `vkEndCommandBuffer` | 대상 커맨드 버퍼를 할당한 상위 `VkCommandPool` |
| `vkResetCommandBuffer` | 대상 커맨드 버퍼를 할당한 상위 `VkCommandPool` |
| `vkCmd*` (모든 커맨드 기록 함수) | 대상 커맨드 버퍼를 할당한 상위 `VkCommandPool` |
| `vkUpdateDescriptorSets` | 각 write/copy의 `dstSet` (VUID-vkUpdateDescriptorSets-pDescriptorWrites-06993) |
| `vkDestroyDevice` | 해당 디바이스에서 생성된 모든 `VkQueue` |

> **암시적 동기화 핵심 원칙**: 커맨드 버퍼를 조작하는 대다수의 명령은 해당 커맨드 버퍼를 생성한 `VkCommandPool`의 상태를 암시적으로 참조한다. 따라서 스레드 간 충돌을 방지하는 가장 안전하고 효율적인 방법은 **스레드마다 독립된 커맨드 풀을 할당하는 것**이다.

---

## 8. 초보자 도입 가이드

멀티스레드 Vulkan을 처음 도입할 때는 다음 단계를 순서대로 거치는 것이 안전하다:

1. **단일 스레드에서 전체 파이프라인 동작 확인**: 멀티스레드 도입 전에 렌더링 결과가 올바른지 검증한다.
2. **검증 레이어 Thread Safety 모듈 활성화**: `VK_LAYER_KHRONOS_validation`이 외부 동기화 위반을 실시간으로 감지한다. 단, 검증 레이어가 모든 동시성 문제를 잡아주지는 않는다.
3. **커맨드 버퍼 기록만 스레드 분리**: 워커 스레드가 각자 전용 `VkCommandPool`에서 Secondary Command Buffer를 기록하고, 메인 스레드가 취합한다.
4. **큐 제출은 단일 스레드로 일원화**: `vkQueueSubmit`/`vkQueuePresentKHR`는 메인 스레드에서만 호출한다.
5. **Frame-in-Flight 확장**: GPU 작업 완료 여부는 `vkQueueWaitIdle` 또는 펜스로 확인한 뒤 리소스를 재사용한다.

> [!TIP]
> `vkQueueWaitIdle`은 해당 큐의 모든 제출이 완료될 때까지 CPU를 블로킹한다. 프레임 간 동기화가 단순할 때 유용하지만, 고성능 파이프라이닝에는 펜스 기반 대기가 더 적합하다.

---

## 9. 실전 멀티스레드 아키텍처 패턴

```
[메인 스레드 (렌더링 오케스트레이션)]
  ├── 프레임 인덱스 관리 (Frame-in-Flight 순환)
  ├── 스왑체인 이미지 획득 (vkAcquireNextImageKHR)
  ├── 워커 스레드 작업 분배 (Task System 디스패치)
  ├── 워커 스레드 기록 완료 대기
  ├── 메인 커맨드 버퍼 취합 및 큐 제출 (vkQueueSubmit)
  └── 화면 표시 요청 (vkQueuePresentKHR)

[워커 스레드 1..N (병렬 커맨드 기록)]
  ├── 스레드 전용 VkCommandPool 소유
  ├── 스레드 전용 VkDescriptorPool 소유 (필요 시)
  ├── Secondary Command Buffer 기록 (오브젝트, 섀도, 포스트프로세싱 등)
  └── 완료된 커맨드 버퍼 핸들을 메인 스레드로 반환
```

**설계 원칙 요약:**
1. **스레드 전용 리소스는 무잠금(Lock-Free)**: `VkCommandPool`, `VkDescriptorPool` 등은 스레드별로 생성하여 잠금 오버헤드를 원천 제거한다.
2. **공유 리소스는 엄격한 상호 배제**: 동일 `VkQueue` 접근 시 호스트 뮤텍스를 적용하거나 전담 제출 스레드로 일원화한다.
3. **검증 레이어(`VK_LAYER_KHRONOS_validation`)의 Thread Safety 모듈 활성화**: 개발 단계에서 동시성 위반을 실시간 감지한다.
