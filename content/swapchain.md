---
title: 스왑체인
slug: swapchain
---

## 소개

스왑체인은 **애플리케이션이 그린 결과를 화면에 표시하는 통로**다. OpenGL의 기본 프레임버퍼처럼 동작하지만, 명시적으로 생성/파괴/재생성을 관리해야 하고 동기화 규칙이 까다롭다.

> **용어 정리**
> - **Surface**: OS가 제공한 윈도우 핸들(Win32 HWND / X11 Window / Wayland surface / Android ANativeWindow)을 추상화한 `VkSurfaceKHR`.
> - **Presentable Image**: 스왑체인에 속한 `VkImage`. 화면에 표시될 수 있는 특별한 이미지.
> - **Acquire**: 그릴 수 있는 presentable image을 한 장 빌려오는 것.
> - **Present**: 그린 이미지를 화면에 표시 요청하는 것.
> - **Recreate**: 윈도우 크기 변경, 포맷 불가 등 이유로 스왑체인을 다시 만드는 것.

이 문서는 **생성 → acquire → draw → present → 회수/재생성** 흐름과 자주 빠지는 주의사항을 정리한다.

---

## 1. 큰 그림

```flowchart
flowchart TD
  A["VkSurfaceKHR — OS 윈도우 핸들에서 생성 (VK_KHR_surface + VK_KHR_win32_surface 등)"]
  B(["vkGetPhysicalDeviceSurfaceSupportKHR — graphics 큐가 present를 지원하는지"])
  C(["vkGetPhysicalDeviceSurfaceCapabilitiesKHR"])
  D(["vkGetPhysicalDeviceSurfaceFormatsKHR"])
  E(["vkGetPhysicalDeviceSurfacePresentModesKHR"])
  F["VkSwapchainKHR + presentable image N장 — vkCreateSwapchainKHR"]
  G["[매 프레임]"]
  H(["vkAcquireNextImageKHR — image index 획득"])
  I(["vkQueueSubmit (그리기)"])
  J(["vkQueuePresentKHR — 화면에 표시 요청"])
  A --> B --> C --> D --> E --> F --> G --> H --> I --> J
```

**핵심 포인트:**

- 스왑체인은 **반드시 present를 지원하는 큐 패밀리**에서 다뤄야 한다(`vkGetPhysicalDeviceSurfaceSupportKHR`).
- **presentable image은 항상 single-sampled**. MSAA로 그리고 싶다면 별도 멀티샘플 이미지에 렌더 → resolve → presentable로 복사.
- 한 번 acquire한 image은 **present 호출 전까지 GPU가 읽고 있을 수 있다.** acquire의 semaphore/fence로 드로우 → present 흐름을 동기화.

---

## 2. `VkSwapchainCreateInfoKHR` — 스왑체인 생성

```c
typedef struct VkSwapchainCreateInfoKHR {
    VkStructureType                  sType;
    const void*                      pNext;
    VkSwapchainCreateFlagsKHR        flags;
    VkSurfaceKHR                     surface;
    uint32_t                         minImageCount;
    VkFormat                         imageFormat;
    VkColorSpaceKHR                  imageColorSpace;
    VkExtent2D                       imageExtent;
    uint32_t                         imageArrayLayers;
    VkImageUsageFlags                imageUsage;
    VkSharingMode                    imageSharingMode;
    uint32_t                         queueFamilyIndexCount;
    const uint32_t*                  pQueueFamilyIndices;
    VkSurfaceTransformFlagBitsKHR    preTransform;
    VkCompositeAlphaFlagBitsKHR      compositeAlpha;
    VkPresentModeKHR                 presentMode;
    VkBool32                         clipped;
    VkSwapchainKHR                   oldSwapchain;        // recreate 시 이전 핸들
} VkSwapchainCreateInfoKHR;
```

> **스펙 원문 (VUID-VkSwapchainCreateInfoKHR-imageFormat-01273)** `imageFormat` and `imageColorSpace` must match the format and colorSpace members, respectively, of one of the `VkSurfaceFormatKHR` structures returned by `vkGetPhysicalDeviceSurfaceFormatsKHR` for the surface.
>> 스왑체인 포맷/컬러스페이스는 **디바이스가 surface에 대해 보고한 것 중에서만** 골라야 한다. 임의의 포맷을 줄 수 없다.

### 2.1. `minImageCount` — 최소 이미지 수

- `VkSurfaceCapabilitiesKHR::minImageCount` 이상이어야 한다. 보통 2 또는 3.
- `minImageCount > maxImageCount`일 수 없음.
- **삼중 버퍼링**: 일반적으로 3 요청. `MAILBOX` 사용 시 핵심.
- **이중 버퍼링**: 2. 렌더 비용이 화면 갱신보다 길지 않을 때.

> **스펙 원문 (VUID-VkSwapchainCreateInfoKHR-minImageCount-01383)** `minImageCount` must be 1 if `presentMode` is either `SHARED_DEMAND_REFRESH_KHR` or `SHARED_CONTINUOUS_REFRESH_KHR`.
>> 공유 presentable 모드에서는 1만 허용. 일반 모드에서는 보통 2~3.

### 2.2. `imageFormat` / `imageColorSpace` — 색 포맷

| 후보 | 의미 | 비고 |
|------|------|------|
| `VK_FORMAT_B8G8R8A8_SRGB` + `COLOR_SPACE_SRGB_NONLINEAR_KHR` | Windows/리눅스 데스크톱 표준 | 가장 무난 |
| `VK_FORMAT_R8G8B8A8_SRGB` + `COLOR_SPACE_SRGB_NONLINEAR_KHR` | macOS(MoltenVK) | 디바이스 보고에 따라 |
| `VK_FORMAT_B8G8R8A8_UNORM` + `COLOR_SPACE_SRGB_NONLINEAR_KHR` | sRGB 변환 없이 선형 파이프라인 | HDR 미사용 시 |

> **실전 팁** sRGB transfer를 쓰려면 `_SRGB` 포맷 + `COLOR_SPACE_SRGB_NONLINEAR_KHR` 조합이 거의 필수. 포맷이 다르다면 셰이더에서 수동 감마 보정 필요.

### 2.3. `imageExtent` — 이미지 크기

- `minImageExtent`와 `maxImageExtent` 사이여야 한다(VUID-pNext-07781).
- `VkSurfaceCapabilitiesKHR::currentExtent`가 0이 아닌 고정 크기일 수 있다(데스크톱). 그 값 그대로 써야 함.
- 0이면 윈도우가 최소화됐다는 의미 — 스왑체인 생성 보류.

```c
VkSurfaceCapabilitiesKHR caps;
vkGetPhysicalDeviceSurfaceCapabilitiesKHR(physDev, surface, &caps);

VkExtent2D extent = caps.currentExtent;
if (extent.width == UINT32_MAX) {  // 윈도우 매니저가 유연한 크기 허용
    extent.width = clamp(windowWidth, caps.minImageExtent.width, caps.maxImageExtent.width);
    extent.height = clamp(windowHeight, caps.minImageExtent.height, caps.maxImageExtent.height);
}
```

### 2.4. `imageUsage` — presentable image에 허용되는 용도

- 디폴트: `COLOR_ATTACHMENT_BIT` (드로우 타깃).
- 추가 가능: `TRANSFER_DST_BIT` (이미지를 다른 이미지에서 복사), `TRANSFER_SRC_BIT` (스크린샷), `STORAGE_BIT` (셰이더에서 읽기/쓰기).
- `vkGetPhysicalDeviceSurfaceCapabilitiesKHR::supportedUsageFlags`의 부분집합이어야 함(VUID-presentMode-01427).

### 2.5. `preTransform` — 화면 회전/미러링

- 모바일/태블릿: `SURFACE_TRANSFORM_ROTATE_90_BIT_KHR` 등.
- 데스크톱: 보통 `IDENTITY_BIT_KHR`.
- 디바이스 보고한 `supportedTransforms` 안에서 선택.

### 2.6. `compositeAlpha` — 알파 합성 모드

| 값 | 의미 |
|----|------|
| `OPAQUE_BIT_KHR` | 알파 무시 (가장 일반적) |
| `PRE_MULTIPLIED_BIT_KHR` | pre-multiplied alpha |
| `POST_MULTIPLIED_BIT_KHR` | straight alpha |
| `INHERIT_BIT_KHR` | OS 기본값 |

> **스펙 원문 (VUID-VkSwapchainCreateInfoKHR-compositeAlpha-parameter)** `compositeAlpha` must be a valid `VkCompositeAlphaFlagBitsKHR` value. 보통 `supportedCompositeAlpha`에서 `OPAQUE_BIT_KHR`를 항상 지원하므로 안전한 선택.

### 2.7. `presentMode` — 표시 모드

자세한 건 §3. 핵심만: `MAILBOX`가 있으면 그게 best.

### 2.8. `clipped`

- `VK_TRUE`: 화면 밖 영역은 클립됨(보이지 않음). `VK_FALSE`: 화면 밖도 그려짐(성능 손해).
- 거의 항상 `VK_TRUE`.

### 2.9. `oldSwapchain` — 재생성

- 첫 생성 시 `VK_NULL_HANDLE`.
- 재생성 시 **이전 스왑체인 핸들을 그대로** 넘기면, 이전 이미지의 메모리를 재사용해 빠르고 안전하게 전환할 수 있다. 이전 스왑체인에서 사용 중이던 image은 **새 스왑체인에서도 사용 가능**해질 수 있다.

---

## 3. `VkPresentModeKHR` — 표시 모드 비교

| 모드 | vsync | 티어링 | 대기 | 입력 지연 | 권장 |
|------|-------|--------|------|----------|------|
| `IMMEDIATE` | ❌ | 있음 | 없음 | 매우 낮음 | 디버그/벤치 |
| `FIFO` (가장 일반적) | ✅ | 없음 | 가능 | 중간 | 기본값 |
| `FIFO_RELAXED` | ✅ (대기 시) | 마지막에 가능 | 짧음 | 보통 | 가끔 늦는 프레임 |
| `MAILBOX` | ✅ | 없음 | 거의 없음 | 낮음 | **게임/시뮬레이션 권장** |
| `FIFO_LATEST_READY` | ✅ | 없음 | 가변 | 가변 | present_id 기반 pacing |
| `SHARED_DEMAND_REFRESH` | OS | 없음 | OS | OS | 공유 surface |
| `SHARED_CONTINUOUS_REFRESH` | OS | 없음 | OS | OS | 공유 surface |

> **스펙 원문 (VkPresentModeKHR 설명 일부)**
> - `IMMEDIATE`: "presentation engine does not wait for a vertical blanking period... may result in visible tearing. No internal queuing."
> - `MAILBOX`: "presentation engine waits for the next vertical blanking period... An internal single-entry queue is used to hold pending presentation requests. If the queue is full when a new presentation request is received, the new request replaces the existing entry."
> - `FIFO`: 스펙은 "스왑 인터벌 = 1과 동일 (wglSwapBuffers)" — 반드시 지원되는 가장 일반 모드.
> - `FIFO_RELAXED`: "스왵 인터벌 = -1과 동일" — 늦지 않으면 FIFO, 늦으면 즉시 표시.

**선택 가이드:**

- **첫 출시**: `FIFO` (모든 디바이스에서 보장). 대기 발생하지만 안정적.
- **성능 중요**: 디바이스가 `MAILBOX` 지원하면 그걸로. 거의 모든 dGPU/최신 모바일은 지원.
- **잠금 장치 미사용 (예: 일부 헤드리스 서버)**: `IMMEDIATE` + `clipped = VK_FALSE` 고려.
- **공유 surface**: `SHARED_*_REFRESH` (Vulkan 1.1+ 또는 `VK_KHR_shared_presentable_image`).

```c
// 지원 모드 조회
uint32_t modeCount;
vkGetPhysicalDeviceSurfacePresentModesKHR(physDev, surface, &modeCount, nullptr);
std::vector<VkPresentModeKHR> modes(modeCount);
vkGetPhysicalDeviceSurfacePresentModesKHR(physDev, surface, &modeCount, modes.data());

VkPresentModeKHR chosen = VK_PRESENT_MODE_FIFO_KHR;  // 폴백
if (has(modes, VK_PRESENT_MODE_MAILBOX_KHR)) chosen = VK_PRESENT_MODE_MAILBOX_KHR;
```

---

## 4. `vkAcquireNextImageKHR` / `vkAcquireNextImage2KHR`

```c
VkResult vkAcquireNextImageKHR(
    VkDevice        device,
    VkSwapchainKHR  swapchain,
    uint64_t        timeout,        // 나노초. UINT64_MAX = 무한 대기 (조건부)
    VkSemaphore     semaphore,      // 둘 중 하나는 VK_NULL_HANDLE이 아니어야 함
    VkFence         fence,          // (semaphore 또는 fence)
    uint32_t*       pImageIndex);   // 결과: 그릴 이미지 인덱스
```

> **스펙 원문 (VUID-VkAcquireNextImageInfoKHR-semaphore-01782)** `semaphore` and `fence` must not both be equal to `VK_NULL_HANDLE`.
>> 둘 다 null이면 안 된다. 일반적으로 **semaphore**로 GPU 측 신호 전달.

**반환값 의미:**

| 반환값 | 의미 | 처리 |
|--------|------|------|
| `VK_SUCCESS` | 정상 acquire | 계속 진행 |
| `VK_SUBOPTIMAL_KHR` | 약간 어긋남 (예: 크기 약간 변경) | 계속 진행 가능, 곧 recreate 권장 |
| `VK_TIMEOUT` | timeout 내 acquire 실패 | 일반적으로 재시도 또는 프레임 스킵 |
| `VK_ERROR_OUT_OF_DATE_KHR` | surface 변경, 현재 스왑체인 무효 | **즉시 recreate** |
| `VK_ERROR_SURFACE_LOST_KHR` | surface 소실 | 윈도우 파괴, 재진입 필요 |
| `VK_ERROR_FULL_SCREEN_EXCLUSIVE_MODE_LOST_EXT` | 전체화면 독점 모드 잃음 | 전체화면 모드 재요청 |

> **스펙 원문** "If an image is acquired successfully, vkAcquireNextImageKHR must either return `VK_SUCCESS` or `VK_SUBOPTIMAL_KHR`. The implementation may return `VK_SUBOPTIMAL_KHR` if the swapchain no longer matches the surface properties exactly, but can still be used for presentation."
>> `SUBOPTIMAL`은 **성공 신호의 일종**. 다음 프레임에 recreate해도 됨.

**timeout 선택:**

- 보통 `UINT64_MAX`로 무한 대기 → 프레임이 늦어도 다음 vsync까지 기다림.
- `VK_KHR_present_wait` 또는 `presentWait2`가 활성화된 surface에서만 진정한 의미의 무한 대기가 안전(VUID-vkAcquireNextImage2KHR-surface-07784). 그 외에는 큰 값(예: 1초)으로 제한 권장.

### 4.1. Semaphore vs Fence

| | Semaphore | Fence |
|---|-----------|-------|
| 신호 받는 곳 | GPU (다음 submit에서 wait) | CPU + GPU |
| 사용 예 | submit → present 흐름 연결 | `vkWaitForFences`로 CPU가 다음 프레임 진행 결정 |
| 권장 | 대부분의 경우 | CPU 측에서 frame pacing 직접 제어할 때 |

**대부분의 코드:** acquire의 semaphore를 마지막 submit의 `signalSemaphore`로 두고, 그 submit을 present가 `waitSemaphore`로 기다림.

---

## 5. `vkQueuePresentKHR` — 표시

```c
typedef struct VkPresentInfoKHR {
    VkStructureType          sType;
    const void*              pNext;
    uint32_t                 waitSemaphoreCount;
    const VkSemaphore*       pWaitSemaphores;    // present 전에 완료돼야 할 신호들
    uint32_t                 swapchainCount;
    const VkSwapchainKHR*    pSwapchains;        // 1개 (멀티 디스플레이도 가능)
    const uint32_t*          pImageIndices;      // 각 스왑체인별 표시할 이미지
    VkResult*                pResults;           // 각 스왑체인별 결과 (옵션)
} VkPresentInfoKHR;

VkResult vkQueuePresentKHR(VkQueue queue, const VkPresentInfoKHR* pPresentInfo);
```

> **스펙 원문 (VUID-vkQueuePresentKHR-pSwapchains-01292)** Each element of pSwapchains must be a swapchain that is created for a surface for which presentation is supported from queue.
>> present를 호출하는 큐가 **그 스왑체인 surface에 대해 present를 지원**해야 함. 아니면 `VK_ERROR_OUT_OF_HOST_MEMORY` 같은 게 아니라 보통 validation 단계에서 잡힘.

> **스펙 원문 (VUID-vkQueuePresentKHR-pWaitSemaphores-01294)** When a semaphore wait operation referring to a binary semaphore defined by the elements of the `pWaitSemaphores` executes on queue, there must be no other queues waiting on the same semaphore.
>> 같은 binary semaphore를 **여러 큐가 동시에 wait하면 안 됨**. acquire의 semaphore는 한 큐에서만 wait.

**반환값 의미:**

- `VK_SUCCESS` 또는 `VK_SUBOPTIMAL_KHR`: 정상.
- `VK_ERROR_OUT_OF_DATE_KHR`: 즉시 recreate.
- `VK_ERROR_FULL_SCREEN_EXCLUSIVE_MODE_LOST_EXT`: 전체화면 모드 재요청.
- `VK_ERROR_PRESENT_TIMING_QUEUE_FULL_EXT`: present timing 큐 가득 참. `VK_KHR_present_id2`/`present_wait2` 경로에서만.

**전형적인 프레임 흐름 (semaphore 동기화):**

```c
// 1. acquire: presentable image 한 장 빌림
uint32_t imageIndex;
VkSemaphore imageAvailable;  // 풀에서 가져옴
VkSemaphore renderFinished;  // 풀에서 가져옴
vkAcquireNextImageKHR(device, swapchain, UINT64_MAX,
                      imageAvailable, VK_NULL_HANDLE, &imageIndex);

// 2. graphics 큐에 submit (imageAvailable → 드로우 → renderFinished 시그널)
VkPipelineStageFlags waitStage = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
VkSubmitInfo submit{};
submit.waitSemaphoreCount = 1;
submit.pWaitSemaphores = &imageAvailable;
submit.pWaitDstStageMask = &waitStage;
submit.commandBufferCount = 1;
submit.pCommandBuffers = &cmd;
submit.signalSemaphoreCount = 1;
submit.pSignalSemaphores = &renderFinished;
vkQueueSubmit(graphicsQueue, 1, &submit, VK_NULL_HANDLE);

// 3. present: renderFinished 시그널을 기다린 뒤 표시
VkPresentInfoKHR present{};
present.waitSemaphoreCount = 1;
present.pWaitSemaphores = &renderFinished;
present.swapchainCount = 1;
present.pSwapchains = &swapchain;
present.pImageIndices = &imageIndex;
vkQueuePresentKHR(presentQueue, &present);
```

---

## 6. 동기화 / 풀 / 프레임 인 플라이트

**세마포어 풀**: acquire/submit/present를 위해 프레임마다 1쌍의 세마포어(`imageAvailable`, `renderFinished`)가 필요. `in_flight_frames` 수만큼 풀링:

```c
constexpr uint32_t MAX_FRAMES_IN_FLIGHT = 2;
std::vector<VkSemaphore> imageAvailableSemaphores(MAX_FRAMES_IN_FLIGHT);
std::vector<VkSemaphore> renderFinishedSemaphores(MAX_FRAMES_IN_FLIGHT);
std::vector<VkFence> inFlightFences(MAX_FRAMES_IN_FLIGHT);

for (uint32_t i = 0; i < MAX_FRAMES_IN_FLIGHT; i++) {
    vkCreateSemaphore(device, &sci, nullptr, &imageAvailableSemaphores[i]);
    vkCreateSemaphore(device, &sci, nullptr, &renderFinishedSemaphores[i]);
    vkCreateFence(device, &fci, nullptr, &inFlightFences[i]);
}
```

**swapchain image과 frame index는 다른 차원**이다:

- 스왑체인 image은 보통 2~3장 (드라이버가 결정).
- `in_flight_frames`는 1~3.
- 각 frame slot은 **자기 frame의 in-flight fence**와 **자기 frame의 두 세마포어**를 사용.
- 같은 image이 두 frame slot에 동시에 잡히지 않게 **image-in-flight fence**도 두면 안전 (더블 acquire 방지).

자세한 패턴은 `synchronization` 및 `thread-safety` 문서 참고.

---

## 7. Recreate (재생성)

다음 상황에서 스왑체인을 재생성해야 한다:

- 윈도우 **리사이즈**.
- `vkAcquireNextImageKHR` / `vkQueuePresentKHR`가 `VK_ERROR_OUT_OF_DATE_KHR` 반환.
- `VK_SUBOPTIMAL_KHR`이 반복적으로 발생 (선택).
- 풀스크린 모드 토글.

**재생성 흐름:**

```c
// 1. 디바이스가 idle임을 보장 (in-flight 작업이 새 스왑체인을 잘못 보지 않게)
vkDeviceWaitIdle(device);

// 2. (옵션) 이전 스왑체인에서 만들어뒀던 image view들을 파괴
for (auto& view : swapchainImageViews) vkDestroyImageView(device, view, nullptr);

// 3. 새 스왑체인 생성 (oldSwapchain = 이전 핸들)
VkSwapchainCreateInfoKHR sci = ...;
sci.oldSwapchain = oldSwapchain;
VkSwapchainKHR newSwapchain;
vkCreateSwapchainKHR(device, &sci, nullptr, &newSwapchain);

// 4. 이전 스왑체인 파괴 (new가 만들어졌으니 더 이상 참조하지 않음)
vkDestroySwapchainKHR(device, oldSwapchain, nullptr);
```

> **팁** `oldSwapchain`을 넘기면, 이전 스왑체인의 image 중 **아직 GPU가 다 쓰지 않은 것**은 자동으로 새 스왑체인에 "이전"으로 들어와 안전하게 사용 가능해진다. 메모리 재사용 효과로도 좋다.

> **주의** `vkDeviceWaitIdle`은 모든 큐를 멈추므로 **프레임 한 프레임이 길어질 수 있다**. 대안: `VK_KHR_swapchain_maintenance1`의 deferred retirement — `oldSwapchain`을 파괴하지 않고 "retired" 상태로 두면, 해당 image을 present가 끝낼 때까지 GPU가 알아서 추적.

---

## 8. 자주 빠지는 주의사항 모음

### 8.1. 생성 단계

- [ ] `minImageCount`가 `VkSurfaceCapabilitiesKHR::minImageCount`보다 작음 → 생성 실패.
- [ ] `imageFormat` / `imageColorSpace`가 `vkGetPhysicalDeviceSurfaceFormatsKHR`가 보고한 것 중 하나가 아님 (VUID-imageFormat-01273).
- [ ] `imageExtent`가 `minImageExtent`~`maxImageExtent` 범위 밖 (VUID-pNext-07781).
- [ ] `minImageCount = 1`로 일반 모드(`FIFO` 등) 생성 → VUID-minImageCount-01383 또는 implicit 제약.
- [ ] `imageArrayLayers = 0` (VUID-imageArrayLayers-01275).
- [ ] `flags`에 `DEFERRED_MEMORY_ALLOCATION_BIT_KHR`를 켰는데 `swapchainMaintenance1` feature 비활성 (VUID-swapchainMaintenance1-10157).
- [ ] `presentMode`가 `MAILBOX`인데 `imageUsage`가 `supportedUsageFlags`의 부분집합이 아님 (VUID-presentMode-01427).
- [ ] `preTransform`이 `supportedTransforms`에 없음.
- [ ] `compositeAlpha`이 `supportedCompositeAlpha`에 없음 (보통 `OPAQUE_BIT_KHR`는 안전).
- [ ] `clipped = VK_FALSE`로 두고 화면 밖도 그림 → 성능 손해, 의도한 경우만.
- [ ] graphics 큐가 surface에 대해 present를 지원하지 않음 (`vkGetPhysicalDeviceSurfaceSupportKHR` 미확인).
- [ ] sharingMode `CONCURRENT`인데 `queueFamilyIndexCount < 2` 또는 `pQueueFamilyIndices`가 유효하지 않음 (VUID-imageSharingMode-...).

### 8.2. Acquire 단계

- [ ] semaphore와 fence를 **둘 다** `VK_NULL_HANDLE`로 호출 (VUID-semaphore-01782).
- [ ] 이미 unsignaled가 아닌 세마포어를 acquire에 전달 (VUID-semaphore-01288).
- [ ] acquire의 세마포어가 다른 큐에 의해 이미 signal/wait 중인 상태 (VUID-semaphore-01781).
- [ ] fence가 다른 큐의 미완료 명령에 연결됨 (VUID-fence-10067).
- [ ] `timeout = UINT64_MAX`인데 forward progress가 보장되지 않는 surface (VUID-surface-07784).
- [ ] `VK_ERROR_OUT_OF_DATE_KHR`를 무시하고 계속 사용.
- [ ] `VK_SUBOPTIMAL_KHR`을 에러로 취급해 프레임 드롭.
- [ ] `UINT64_MAX` 타임아웃을 무한 루프의 안전망으로만 믿고, surface lost/out-of-date 처리를 누락.

### 8.3. Present 단계

- [ ] `pSwapchains`의 surface에 대해 queue가 present를 지원하지 않음 (VUID-pSwapchains-01292).
- [ ] acquire의 imageAvailable 세마포어를 present의 `pWaitSemaphores`로 직접 넘기는데, **동일한 binary semaphore를 여러 큐가 동시에 wait** (VUID-pWaitSemaphores-01294).
- [ ] `pWaitSemaphores`의 세마포어가 `VK_SEMAPHORE_TYPE_BINARY`가 아님 (VUID-pWaitSemaphores-03267).
- [ ] signal되지 않은 세마포어를 `pWaitSemaphores`에 넣음.
- [ ] `pImageIndices`가 잘못된 인덱스(스왑체인에 없는 슬롯).
- [ ] `pResults`를 nullptr로 두면서 여러 스왑체인 present → 개별 결과 누락.
- [ ] 같은 큐에 너무 많은 `vkQueuePresentKHR`를 큐잉하고 `VK_ERROR_PRESENT_TIMING_QUEUE_FULL_EXT`를 무시.

### 8.4. Recreate / 수명 관리

- [ ] `vkDeviceWaitIdle` 없이 이전 스왑체인을 파괴 → 드로우 중 image 사용.
- [ ] 이전 스왑체인의 `imageView`를 파괴하지 않고 새 스왑체인을 만들고 그대로 사용.
- [ ] `oldSwapchain`을 넘기지 않고 매번 새 스왑체인만 생성 → 이전 image이 dangling.
- [ ] 새 스왑체인의 `imageCount`가 이전과 다른 경우, 이미지 view / 프레임 버퍼를 그대로 사용.
- [ ] 윈도우 minimize 상태(`currentExtent = 0`)에서 `imageExtent = {0, 0}`으로 생성 → VUID-imageExtent-01689.
- [ ] 동시 recreate: 두 스레드가 동시에 `vkCreateSwapchainKHR` 호출 (외부 동기화 누락).
- [ ] fullscreen exclusive 모드 잃은 후 `VK_ERROR_FULL_SCREEN_EXCLUSIVE_MODE_LOST_EXT` 미처리.
- [ ] `VK_KHR_swapchain_maintenance1`의 deferred retirement을 쓸 때 retired 스왑체인을 영원히 파괴하지 않음.

### 8.5. 일반 / 성능

- [ ] `minImageCount = 2`로 삼중 버퍼링 의도 → 2로 두면 vsync + 늦은 GPU에서 stall. 3 권장.
- [ ] `MAILBOX`를 모르고 `FIFO`만 사용 → 입력 지연 증가.
- [ ] `vkAcquireNextImageKHR`의 세마포어를 **매 프레임 새로 생성** → 매 프레임 생성 비용. 풀 사용.
- [ ] `pResults`를 무시하고 모든 스왑체인을 하나의 `VkResult`로 받으려 함 → 배열로 받기.
- [ ] 풀스크린 모드 + `MAILBOX` 조합에서 present throttle 누락.

---

## 9. 빠른 참조 — 프레임당 스왑체인 흐름

| 단계 | API | 동기화 객체 |
|------|-----|------------|
| 그릴 이미지 빌리기 | `vkAcquireNextImageKHR` | `imageAvailable` 세마포어 (시그널) |
| 그리기 | `vkQueueSubmit(graphicsQueue, ...)` | `imageAvailable` wait, `renderFinished` 시그널 |
| 표시 | `vkQueuePresentKHR(presentQueue, ...)` | `renderFinished` wait |
| 다음 프레임 | 위 반복 | fence로 in-flight 추적 |
