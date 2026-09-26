---
title: 스왑체인
slug: swapchain
---

## 소개

스왑체인(Swapchain)은 **애플리케이션이 렌더링한 이미지를 화면에 표시하기 위한 버퍼 큐이자 전송 통로**다. 운영체제의 윈도우 시스템과 직접 연동되며, 이미지 획득, 렌더링, 프레젠테이션, 재생성(Recreation) 과정을 명시적인 동기화 객체와 함께 직접 관리해야 한다.

> **주요 용어**
> - **서피스 (`VkSurfaceKHR`)**: 네이티브 OS 윈도우 핸들을 추상화한 인스턴스 수준 객체.
> - **프레젠터블 이미지 (Presentable Image)**: 스왑체인이 소유하며 화면 표시에 쓰이는 `VkImage`.
> - **획득 (Acquire)**: 렌더링을 위해 스왑체인으로부터 가용 이미지의 인덱스를 빌려오는 과정.
> - **프레젠트 (Present)**: 렌더링이 완료된 이미지를 디스플레이 엔진에 전달하여 화면 출력을 요청하는 과정.
> - **재생성 (Recreation)**: 윈도우 크기 변경이나 서피스 상태 변화로 스왑체인을 다시 생성하는 과정.

---

## 1. 스왑체인 실행 흐름

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

**핵심 설계 규칙:**
- 스왑체인 이미지는 **항상 단일 샘플링(`VK_SAMPLE_COUNT_1_BIT`)**이다. MSAA를 적용하려면 멀티샘플 렌더 타깃에 먼저 렌더링한 후 resolve 작업을 거쳐 스왑체인 이미지로 복사해야 한다.
- `vkAcquireNextImageKHR`에서 전달한 세마포어는 GPU 렌더링 명령의 대기 조건(`pWaitDstStageMask`)으로 연결하고, 렌더링 완료 세마포어를 `vkQueuePresentKHR`의 대기 조건으로 넘겨야 레이스 컨디션을 방지할 수 있다.

---

## 2. 스왑체인 생성 (`VkSwapchainCreateInfoKHR`)

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
    VkSwapchainKHR                   oldSwapchain; // 재생성 시 이전 스왑체인 핸들 지정
} VkSwapchainCreateInfoKHR;
```

---

### 2.1. 이미지 수 (`minImageCount`)

- `VkSurfaceCapabilitiesKHR::minImageCount` 이상이어야 한다.
- `maxImageCount`가 0이 아닌 경우(`0`은 제한 없음) `minImageCount`는 `maxImageCount`를 초과할 수 없다.
- `presentMode`가 `SHARED_DEMAND_REFRESH_KHR` 또는 `SHARED_CONTINUOUS_REFRESH_KHR`이면 `minImageCount`는 반드시 1이어야 한다(VUID-VkSwapchainCreateInfoKHR-minImageCount-01383).
- **더블 버퍼링**: 통상 2장 요청.
- **트리플 버퍼링**: 통상 3장 요청. `MAILBOX` 모드에서 GPU 대기 없이 파이프라인을 원활하게 가동하려면 3장을 권장한다.

```c
uint32_t imageCount = caps.minImageCount + 1;
if (caps.maxImageCount > 0 && imageCount > caps.maxImageCount) {
    imageCount = caps.maxImageCount;
}
```

---

### 2.2. 포맷과 색 공간 (`imageFormat`, `imageColorSpace`)

스왑체인 포맷과 색 공간은 반드시 `vkGetPhysicalDeviceSurfaceFormatsKHR`가 반환한 지원 목록 중에서 선택해야 한다(VUID-VkSwapchainCreateInfoKHR-imageFormat-01273).

| 포맷 및 색 공간 | 용도 및 특징 |
|---|---|
| `VK_FORMAT_B8G8R8A8_SRGB`<br>`VK_COLOR_SPACE_SRGB_NONLINEAR_KHR` | Windows 및 리눅스 데스크톱의 표준 구성. 감마 보정 자동 처리 |
| `VK_FORMAT_R8G8B8A8_SRGB`<br>`VK_COLOR_SPACE_SRGB_NONLINEAR_KHR` | macOS(MoltenVK) 및 모바일 환경에서 널리 지원 |
| `VK_FORMAT_B8G8R8A8_UNORM`<br>`VK_COLOR_SPACE_SRGB_NONLINEAR_KHR` | 셰이더에서 수동 감마 보정을 수행할 때 사용 |

---

### 2.3. 이미지 해상도 (`imageExtent`)

- `caps.minImageExtent`와 `caps.maxImageExtent` 사이여야 한다.
- `caps.currentExtent.width`가 `0xFFFFFFFF`가 아니라면 창 관리자가 정한 크기이므로 해당 값을 그대로 사용해야 한다.
- `currentExtent.width`가 `0xFFFFFFFF`라면 애플리케이션의 윈도우 클라이언트 해상도를 범위 내로 클램핑하여 지정한다.
- **윈도우 최소화 처리**: 창이 최소화되면 `currentExtent.width == 0 && currentExtent.height == 0`이 반환된다. 이때는 스왑체인을 생성할 수 없으므로 크기가 0보다 커질 때까지 렌더 루프와 재생성을 일시 중단해야 한다.

```c
VkExtent2D chooseSwapExtent(const VkSurfaceCapabilitiesKHR& caps, uint32_t winWidth, uint32_t winHeight) {
    if (caps.currentExtent.width != UINT32_MAX) {
        return caps.currentExtent;
    }
    VkExtent2D actualExtent = { winWidth, winHeight };
    actualExtent.width = std::clamp(actualExtent.width, caps.minImageExtent.width, caps.maxImageExtent.width);
    actualExtent.height = std::clamp(actualExtent.height, caps.minImageExtent.height, caps.maxImageExtent.height);
    return actualExtent;
}
```

---

### 2.4. 기타 주요 파라미터

- **`imageUsage`**: 렌더 타깃으로 직접 쓸 경우 `VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT`를 지정한다. 후처리 블릿의 목적지로 쓰려면 `VK_IMAGE_USAGE_TRANSFER_DST_BIT`를 추가해야 하며, 항상 `caps.supportedUsageFlags`의 부분집합이어야 한다.
- **`preTransform`**: 모바일 장치의 회전 처리 플래그다. 데스크톱에서는 `caps.currentTransform`(`VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR`)을 전달한다.
- **`compositeAlpha`**: 창 관리자와의 알파 블렌딩 방식이다. 일반 창 모드나 전체화면에서는 `VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR`를 사용한다.
- **`clipped`**: `VK_TRUE`로 설정하면 다른 창에 가려진 픽셀의 처리를 건너뛰어 성능을 절약한다.
- **`imageArrayLayers`**: 멀티뷰 렌더링이나 스테레오스코픽 렌더링에서 사용한다. 일반 2D 렌더링에서는 1.
- **`flags`**: `VK_SWAPCHAIN_CREATE_SPLIT_INSTANCE_BIND_REGIONS_BIT_KHR`(멀티 GPU), `VK_SWAPCHAIN_CREATE_PROTECTED_BIT_KHR`(보호 메모리) 등 특수 용도 플래그. 일반 사용에서는 0.
- **`imageSharingMode`**: 그래픽스 큐와 프레젠트 큐가 다른 큐 패밀리일 때 `VK_SHARING_MODE_CONCURRENT`로 설정하거나, 소유권 이전 배리어를 사용한다. 동일 큐 패밀리이면 `VK_SHARING_MODE_EXCLUSIVE`(기본값).
- **`oldSwapchain`**: 스왑체인 재생성 시 기존 핸들을 넘기면 드라이버가 내부 메모리 전환을 최적화한다. `oldSwapchain`으로 지정된 스왑체인은 **retired** 상태가 되며 더 이상 이미지를 획득할 수 없지만, 이미 획득한 이미지는 여전히 프레젠트 가능하다(VUID-VkSwapchainKHR-oldSwapchain-01933). 생성 실패 시에도 retired 상태가 된다. 미획득 이미지는 자동으로 해제된다. deferred retirement가 지원되지 않는 드라이버에서는 `vkDeviceWaitIdle` 비용이 발생할 수 있다. `VK_ERROR_NATIVE_WINDOW_IN_USE_KHR`는 네이티브 윈도우가 다른 API에 바인딩되어 있을 때 발생한다.

---

## 3. 프레젠테이션 모드 (`VkPresentModeKHR`)

`vkGetPhysicalDeviceSurfacePresentModesKHR`로 지원 모드를 확인한 뒤 선택한다.

| 모드 | VSync | 화면 티어링 | 대기 시간 | 지연 시간 | 권장 용도 |
|---|---|---|---|---|---|
| `VK_PRESENT_MODE_FIFO_KHR` | 적용 | 없음 | VSync 주기에 맞춰 대기 | 보통 | 기본값 (Vulkan 스펙상 항상 지원 보장) |
| `VK_PRESENT_MODE_MAILBOX_KHR` | 적용 | 없음 | 거의 없음 | 매우 낮음 | **게임 및 실시간 3D 그래픽 (최우선 권장)** |
| `VK_PRESENT_MODE_FIFO_RELAXED_KHR` | 조건부 적용 | 지연 시 발생 가능 | 짧음 | 보통 | 간헐적 프레임 드롭이 발생하는 시뮬레이션 |
| `VK_PRESENT_MODE_IMMEDIATE_KHR` | 미적용 | 발생 | 없음 | 최저 | 지연 시간 측정 및 벤치마크 |
| `VK_PRESENT_MODE_FIFO_LATEST_READY_KHR` | 적용 | 없음 | VSync 직전까지 대기 | 낮음 | MAILBOX 대안 (Vulkan 1.4) |
| `VK_PRESENT_MODE_SHARED_DEMAND_REFRESH_KHR` | — | — | — | — | 공유 프레젠테이션 (단일 갱신) |
| `VK_PRESENT_MODE_SHARED_CONTINUOUS_REFRESH_KHR` | — | — | — | — | 공유 프레젠테이션 (지속 갱신) |

> SHARED_* 모드는 `VkSharedPresentSurfaceCapabilitiesKHR::sharedPresentSupportedUsageFlags`를 확인해야 하며, 일반 `supportedUsageFlags`와 다를 수 있다(VUID-VkSwapchainCreateInfoKHR-imageUsage-01384). 또한 SHARED_* 모드 사용 시 `minImageCount`는 1이어야 한다(VUID-VkSwapchainCreateInfoKHR-minImageCount-01383).

- **`FIFO`**: 렌더링이 빨라도 수직 동기 주기에 맞춰 큐가 대기하므로 모니터 주사율을 초과하는 렌더링이 차단된다.
- **`MAILBOX`**: 큐가 가득 찬 상태에서 새 프레젠트 요청이 들어오면 대기하지 않고 기존 대기 이미지를 최신 렌더링 결과로 대체한다.

---

## 4. 이미지 획득 (`vkAcquireNextImageKHR`)

스왑체인 큐에서 렌더링에 사용할 수 있는 다음 이미지의 인덱스를 가져온다.

```c
VkResult vkAcquireNextImageKHR(
    VkDevice        device,
    VkSwapchainKHR  swapchain,
    uint64_t        timeout,       // 나노초 단위 (UINT64_MAX는 무한 대기)
    VkSemaphore     semaphore,     // 획득 완료 시 시그널될 세마포어
    VkFence         fence,         // 획득 완료 시 시그널될 펜스 (둘 중 하나는 필수)
    uint32_t*       pImageIndex);  // 반환받을 이미지 인덱스
```

**반환값에 따른 처리 규칙:**

| 반환 코드 | 상태 분석 | 처리 절차 |
|---|---|---|
| `VK_SUCCESS` | 이미지 획득 성공 | 정상 렌더링 진행 |
| `VK_SUBOPTIMAL_KHR` | 이미지는 획득했으나 서피스 속성과 미세 불일치 | 현재 프레임은 정상 렌더링하고, 프레젠트 완료 후 스왑체인 재생성 |
| `VK_ERROR_OUT_OF_DATE_KHR` | 창 크기 변경 등으로 스왑체인이 완전히 무효화됨 | 현재 프레임 렌더링을 중단하고 **즉시 스왑체인 재생성** 후 재시도 |
| `VK_ERROR_SURFACE_LOST_KHR` | 서피스 핸들이 유효하지 않게 됨 | 서피스를 처음부터 다시 생성하고 스왑체인 재구축 |
| `VK_TIMEOUT` | 지정 시간 내에 이미지를 획득하지 못함 | 타임아웃 처리 (재시도 또는 프레임 스킵) |
| `VK_NOT_READY` | 아직 준비된 이미지가 없음 (비블로킹 폴링 시) | 다음 프레임에서 재시도 |
| `VK_ERROR_FULL_SCREEN_EXCLUSIVE_MODE_LOST_EXT` | 전체화면 독점 모드가 외부 요인으로 해제됨 | 스왑체인 재생성 필요 |

> [!WARNING]
> `semaphore`와 `fence`를 둘 다 `VK_NULL_HANDLE`로 넘기면 스펙 위반이다(VUID-VkAcquireNextImageInfoKHR-semaphore-01782).
> forward progress를 보장할 수 없는 서피스에서는 `timeout`에 `UINT64_MAX`를 사용하면 안 된다(VUID-vkAcquireNextImage2KHR-surface-07784). 무한 대기는 데드락을 유발할 수 있다.

---

## 5. 화면 표시 요청 (`vkQueuePresentKHR`)

렌더링 작업이 끝난 이미지를 화면에 표시하도록 프레젠트 큐에 요청한다.

```c
typedef struct VkPresentInfoKHR {
    VkStructureType          sType;
    const void*              pNext;
    uint32_t                 waitSemaphoreCount;
    const VkSemaphore*       pWaitSemaphores; // 렌더링 완료 세마포어
    uint32_t                 swapchainCount;
    const VkSwapchainKHR*    pSwapchains;
    const uint32_t*          pImageIndices;   // 표시할 이미지 인덱스
    VkResult*                pResults;        // 개별 스왑체인 결과 (단일 시 nullptr 가능)
} VkPresentInfoKHR;

VkResult vkQueuePresentKHR(VkQueue queue, const VkPresentInfoKHR* pPresentInfo);
```

- `vkQueuePresentKHR` 역시 `VK_ERROR_OUT_OF_DATE_KHR`나 `VK_SUBOPTIMAL_KHR`를 반환할 수 있다. 이 경우 다음 프레임 진입 전에 재생성 플래그를 설정해야 한다.
- `queue`는 반드시 해당 서피스에 대한 프레젠트 지원(`vkGetPhysicalDeviceSurfaceSupportKHR`)이 확인된 큐여야 한다(VUID-vkQueuePresentKHR-pSwapchains-01292).
- `pWaitSemaphores`의 바이너리 세마포어를 다른 큐가 동시에 대기하고 있으면 안 된다(VUID-vkQueuePresentKHR-pWaitSemaphores-01294).

---

## 6. 비행 중인 프레임 동기화 (Frames-in-Flight)

CPU가 GPU의 렌더링 완료를 기다리지 않고 앞서 명령을 기록하려면 다중 프레임 슬롯(통상 2개)을 운용해야 한다.

```
Frame Slot 0: [ Fence 0 ] [ ImageAvailable 0 ] [ RenderFinished 0 ]
Frame Slot 1: [ Fence 1 ] [ ImageAvailable 1 ] [ RenderFinished 1 ]
```

```c
constexpr uint32_t MAX_FRAMES_IN_FLIGHT = 2;
uint32_t currentFrame = 0;

void drawFrame() {
    // 1. 현재 프레임 슬롯의 펜스 대기 (이전 해당 슬롯 작업 완료 확인)
    vkWaitForFences(device, 1, &inFlightFences[currentFrame], VK_TRUE, UINT64_MAX);

    // 2. 가용 이미지 인덱스 획득
    uint32_t imageIndex;
    VkResult result = vkAcquireNextImageKHR(device, swapchain, UINT64_MAX,
        imageAvailableSemaphores[currentFrame], VK_NULL_HANDLE, &imageIndex);

    if (result == VK_ERROR_OUT_OF_DATE_KHR) {
        recreateSwapchain();
        return;
    }

    // 3. 동일한 스왑체인 이미지가 아직 다른 프레임에서 작업 중인지 확인
    if (imagesInFlight[imageIndex] != VK_NULL_HANDLE) {
        vkWaitForFences(device, 1, &imagesInFlight[imageIndex], VK_TRUE, UINT64_MAX);
    }
    imagesInFlight[imageIndex] = inFlightFences[currentFrame];

    // 4. 커맨드 버퍼 제출
    vkResetFences(device, 1, &inFlightFences[currentFrame]);

    VkPipelineStageFlags waitStages[] = { VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT };
    VkSubmitInfo submitInfo{};
    submitInfo.sType                = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    submitInfo.waitSemaphoreCount   = 1;
    submitInfo.pWaitSemaphores      = &imageAvailableSemaphores[currentFrame];
    submitInfo.pWaitDstStageMask    = waitStages;
    submitInfo.commandBufferCount   = 1;
    submitInfo.pCommandBuffers      = &commandBuffers[imageIndex];
    submitInfo.signalSemaphoreCount = 1;
    submitInfo.pSignalSemaphores    = &renderFinishedSemaphores[currentFrame];

    vkQueueSubmit(graphicsQueue, 1, &submitInfo, inFlightFences[currentFrame]);

    // 5. 화면 프레젠트 요청
    VkPresentInfoKHR presentInfo{};
    presentInfo.sType              = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR;
    presentInfo.waitSemaphoreCount = 1;
    presentInfo.pWaitSemaphores    = &renderFinishedSemaphores[currentFrame];
    presentInfo.swapchainCount     = 1;
    presentInfo.pSwapchains        = &swapchain;
    presentInfo.pImageIndices      = &imageIndex;

    result = vkQueuePresentKHR(presentQueue, &presentInfo);
    if (result == VK_ERROR_OUT_OF_DATE_KHR || result == VK_SUBOPTIMAL_KHR || framebufferResized) {
        framebufferResized = false;
        recreateSwapchain();
    }

    currentFrame = (currentFrame + 1) % MAX_FRAMES_IN_FLIGHT;
}
```

---

## 7. 스왑체인 재생성 (Recreation)

창 크기가 변경되거나 서피스 상태가 바뀔 때는 스왑체인을 안전하게 재생성해야 한다.

```c
void recreateSwapchain() {
    int width = 0, height = 0;
    glfwGetFramebufferSize(window, &width, &height);
    while (width == 0 || height == 0) { // 창 최소화 시 대기 루프
        glfwGetFramebufferSize(window, &width, &height);
        glfwWaitEvents();
    }

    // 1. 실행 중인 모든 GPU 작업 대기
    vkDeviceWaitIdle(device);

    // 2. 기존 스왑체인 이미지 뷰 정리
    for (auto imageView : swapchainImageViews) {
        vkDestroyImageView(device, imageView, nullptr);
    }
    swapchainImageViews.clear();

    // 3. 서피스 역량 재조회 및 새 스왑체인 생성
    VkSurfaceCapabilitiesKHR caps;
    vkGetPhysicalDeviceSurfaceCapabilitiesKHR(physDev, surface, &caps);
    VkExtent2D newExtent = chooseSwapExtent(caps, width, height);

    VkSwapchainCreateInfoKHR createInfo{};
    createInfo.sType            = VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR;
    createInfo.surface          = surface;
    createInfo.minImageCount    = chooseImageCount(caps);
    createInfo.imageFormat      = swapchainImageFormat;
    createInfo.imageColorSpace  = swapchainColorSpace;
    createInfo.imageExtent      = newExtent;
    createInfo.imageArrayLayers = 1;
    createInfo.imageUsage       = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT;
    createInfo.preTransform     = caps.currentTransform;
    createInfo.compositeAlpha   = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
    createInfo.presentMode      = choosePresentMode();
    createInfo.clipped          = VK_TRUE;
    createInfo.oldSwapchain     = swapchain; // 기존 스왑체인 핸들 전달

    VkSwapchainKHR newSwapchain;
    vkCreateSwapchainKHR(device, &createInfo, nullptr, &newSwapchain);

    // 4. 이전 스왑체인 파괴 및 핸들 갱신
    vkDestroySwapchainKHR(device, swapchain, nullptr);
    swapchain = newSwapchain;

    // 5. 새 이미지 뷰 생성
    createImageViews();
}
```

---

## 8. 주요 점검 사항

### 8.1. 스왑체인 생성
- [ ] 서피스 지원 포맷과 색 공간 목록(`vkGetPhysicalDeviceSurfaceFormatsKHR`) 내에서 선택했는지 확인
- [ ] `minImageCount`가 서피스 최소 요구치 이상이며 최댓값을 초과하지 않는지 확인
- [ ] 윈도우 크기 0 상태에서 스왑체인 생성을 호출하지 않도록 가드했는지 확인
- [ ] 그래픽스 큐와 프레젠트 큐 패밀리가 다를 경우 `VK_SHARING_MODE_CONCURRENT` 또는 소유권 이전 배리어를 적용했는지 확인

### 8.2. 이미지 획득 및 프레젠트
- [ ] `vkAcquireNextImageKHR`에 유효한 세마포어나 펜스를 하나 이상 전달했는지 확인
- [ ] `VK_ERROR_OUT_OF_DATE_KHR` 발생 시 즉시 렌더 루프를 중단하고 재생성을 호출하는지 확인
- [ ] `VK_SUBOPTIMAL_KHR`를 치명 오류로 취급하지 않고 프레임 출력 후 재생성하도록 처리했는지 확인
- [ ] 프레젠트 호출에 사용하는 세마포어가 단일 큐 대기 규칙을 위반하지 않는지 확인

### 8.3. 수명 주기 및 재생성
- [ ] 스왑체인 파괴 전에 해당 스왑체인 이미지를 참조하는 이미지 뷰와 프레임버퍼를 먼저 정리했는지 확인
- [ ] 재생성 시 `vkDeviceWaitIdle`을 호출하여 비행 중인 GPU 커맨드가 끝났음을 보장했는지 확인
- [ ] 스왑체인 재생성 시 `oldSwapchain` 멤버에 기존 핸들을 연결했는지 확인

---

## 9. 빠른 참조 요약

| 단계 | 주요 API | 동기화 메커니즘 |
|---|---|---|
| **이미지 인덱스 획득** | `vkAcquireNextImageKHR` | `imageAvailableSemaphore` 시그널 |
| **명령 제출 및 렌더링** | `vkQueueSubmit` | `imageAvailableSemaphore` 대기, `renderFinishedSemaphore` 시그널, 펜스 전달 |
| **화면 출력 요청** | `vkQueuePresentKHR` | `renderFinishedSemaphore` 대기 |
| **프레임 교대** | `vkWaitForFences`, `vkResetFences` | CPU에서 프레임 슬롯 동기화 |
