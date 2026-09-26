---
title: Windowing / Surface (WSI)
slug: wsi-surface
---

## 소개

**WSI(Window System Integration)**는 플랫폼 독립적인 Vulkan 코어 API와 운영체제별 윈도우 시스템을 연결하는 계층이다. `VkSurfaceKHR` 객체는 플랫폼 고유의 네이티브 윈도우 핸들(Win32 `HWND`, X11 `xcb_window_t`, Wayland `wl_surface`, Android `ANativeWindow` 등)을 Vulkan이 다룰 수 있는 **추상 서피스 객체**로 래핑한다.

> **주요 용어**
> - **서피스 (`VkSurfaceKHR`)**: 플랫폼별 네이티브 창 핸들을 감싼 플랫폼 중립적 인스턴스 수준 객체.
> - **WSI (Window System Integration)**: 윈도우 시스템과 통신하기 위한 확장 집합 (`VK_KHR_surface` 및 플랫폼별 확장).
> - **프레젠테이션 엔진 (Presentation Engine)**: 서피스에 전달된 이미지를 실제 디스플레이에 출력하는 OS 및 드라이버 컴포넌트.
> - **헤드리스 서피스 (Headless Surface)**: 실제 창 없이 가상 서피스를 생성하여 오프스크린 렌더링이나 CI 환경 테스트에 사용 (`VK_EXT_headless_surface`).
> - **Surfaceless Context**: 서피스 없이 스왑체인을 생성하는 방식 (`VK_KHR_surfaceless_context` 또는 `VK_EXT_surface_maintenance1`).

---

## 1. WSI 아키텍처와 역할

Vulkan 코어 API는 창 생성, 입력 이벤트, 윈도우 크기 변경과 같은 OS 종속적 기능을 직접 처리하지 않는다. 이러한 작업은 애플리케이션이 네이티브 플랫폼 API(또는 GLFW, SDL 같은 크로스 플랫폼 라이브러리)를 통해 처리해야 한다.

```
[OS 윈도우 시스템]  <── WSI 계층 ──>  [VkSurfaceKHR]  <──>  [VkSwapchainKHR]  <──>  [GPU 렌더링 결과]
```

| 처리 단계 | 주관 계층 | 수행 내용 |
|---|---|---|
| 창 생성 및 이벤트 루프 | OS 네이티브 API | Win32 메시지 루프, X11 이벤트 폴링, Android Looper 등 |
| 서피스 생성 | Vulkan WSI 확장 | `vkCreateWin32SurfaceKHR` 등으로 네이티브 핸들을 `VkSurfaceKHR`로 래핑 |
| 프레젠트 지원 쿼리 | Vulkan WSI 확장 | 물리 디바이스의 특정 큐 패밀리가 해당 서피스 출력을 지원하는지 확인 |
| 스왑체인 관리 | Vulkan 스왑체인 | `vkCreateSwapchainKHR`로 서피스 규격에 맞는 프레젠터블 이미지 생성 |
| 화면 출력 | 프레젠테이션 엔진 | `vkQueuePresentKHR` 호출을 받아 OS 디스플레이 서버가 화면 주사 |

---

## 2. 플랫폼별 확장 매트릭스

`VK_KHR_surface`는 모든 플랫폼의 기본이 되는 인스턴스 확장이며, 각 OS에 맞는 세부 플랫폼 확장을 인스턴스 생성 시 함께 활성화해야 한다.

| 플랫폼 | 확장명 | 필요 네이티브 헤더 | 빌드 매크로 |
|---|---|---|---|
| Microsoft Windows | `VK_KHR_win32_surface` | `<windows.h>` | `VK_USE_PLATFORM_WIN32_KHR` |
| Linux (X11 XCB) | `VK_KHR_xcb_surface` | `<xcb/xcb.h>` | `VK_USE_PLATFORM_XCB_KHR` |
| Linux (X11 Xlib) | `VK_KHR_xlib_surface` | `<X11/Xlib.h>` | `VK_USE_PLATFORM_XLIB_KHR` |
| Linux (Wayland) | `VK_KHR_wayland_surface` | `<wayland-client.h>` | `VK_USE_PLATFORM_WAYLAND_KHR` |
| Android | `VK_KHR_android_surface` | `<android/native_window.h>` | `VK_USE_PLATFORM_ANDROID_KHR` |
| macOS / iOS | `VK_EXT_metal_surface` 또는 `VK_MVK_macos_surface` | Metal 프레임워크 | `VK_USE_PLATFORM_METAL_EXT` |
| QNX | `VK_QNX_screen_surface` | `<screen/screen.h>` | `VK_USE_PLATFORM_SCREEN_QNX` |
| Fuchsia | `VK_FUCHSIA_imagepipe_surface` | `<fuchsia/images/cpp/fidl.h>` | `VK_USE_PLATFORM_FUCHSIA` |
| DirectFB | `VK_EXT_directfb_surface` | `<directfb.h>` | `VK_USE_PLATFORM_DIRECTFB_EXT` |
| GGP (Stadia) | `VK_GGP_stream_descriptor_surface` | GGP SDK | `VK_USE_PLATFORM_GGP` |
| OpenHarmony | `VK_OHOS_native_window_surface` | `<native_window.h>` | `VK_USE_PLATFORM_OHOS` |
| VI (Nintendo) | `VK_NN_vi_surface` | Nintendo SDK | `VK_USE_PLATFORM_VI_NN` |
| 헤드리스 / 오프스크린 | `VK_EXT_headless_surface` | 없음 | 없음 |

> 전체 플랫폼 목록은 Vulkan 스펙 Appendix H, Table 131을 참조.

```c
const char* enabledExtensions[] = {
    VK_KHR_SURFACE_EXTENSION_NAME,
#if defined(VK_USE_PLATFORM_WIN32_KHR)
    VK_KHR_WIN32_SURFACE_EXTENSION_NAME,
#elif defined(VK_USE_PLATFORM_WAYLAND_KHR)
    VK_KHR_WAYLAND_SURFACE_EXTENSION_NAME,
#elif defined(VK_USE_PLATFORM_XCB_KHR)
    VK_KHR_XCB_SURFACE_EXTENSION_NAME,
#endif
};

VkInstanceCreateInfo createInfo{};
createInfo.sType                   = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
createInfo.enabledExtensionCount   = sizeof(enabledExtensions) / sizeof(enabledExtensions[0]);
createInfo.ppEnabledExtensionNames = enabledExtensions;
```

---

## 3. 플랫폼별 서피스 생성

### 3.1. Windows (Win32)

```c
VkWin32SurfaceCreateInfoKHR sci{};
sci.sType     = VK_STRUCTURE_TYPE_WIN32_SURFACE_CREATE_INFO_KHR;
sci.hinstance = hInstance; // GetModuleHandle(nullptr)
sci.hwnd      = hWnd;      // CreateWindowEx로 생성된 창 핸들

VkSurfaceKHR surface;
vkCreateWin32SurfaceKHR(instance, &sci, nullptr, &surface);
```

> VUID-VkWin32SurfaceCreateInfoKHR-hwnd-01308: `hwnd`는 유효한 윈도우 핸들이어야 한다.
> VUID-VkWin32SurfaceCreateInfoKHR-hinstance-01307: `hinstance`은 유효한 인스턴스 핸들이어야 한다.

---

### 3.2. Linux (XCB)

```c
VkXcbSurfaceCreateInfoKHR sci{};
sci.sType      = VK_STRUCTURE_TYPE_XCB_SURFACE_CREATE_INFO_KHR;
sci.connection = xcbConnection;
sci.window     = xcbWindowId;

VkSurfaceKHR surface;
vkCreateXcbSurfaceKHR(instance, &sci, nullptr, &surface);
```

---

### 3.3. Linux (Wayland)

```c
VkWaylandSurfaceCreateInfoKHR sci{};
sci.sType   = VK_STRUCTURE_TYPE_WAYLAND_SURFACE_CREATE_INFO_KHR;
sci.display = wlDisplay;
sci.surface = wlSurface;

VkSurfaceKHR surface;
vkCreateWaylandSurfaceKHR(instance, &sci, nullptr, &surface);
```

---

### 3.4. Android

```c
VkAndroidSurfaceCreateInfoKHR sci{};
sci.sType  = VK_STRUCTURE_TYPE_ANDROID_SURFACE_CREATE_INFO_KHR;
sci.window = aNativeWindow; // ANativeWindow 포인터

VkSurfaceKHR surface;
vkCreateAndroidSurfaceKHR(instance, &sci, nullptr, &surface);
```

---

### 3.5. 헤드리스 환경 (`VK_EXT_headless_surface`)

창을 생성할 수 없는 CI/CD 서버 환경이나 순수 오프스크린 렌더링 파이프라인에서 사용한다.

```c
VkHeadlessSurfaceCreateInfoEXT sci{};
sci.sType = VK_STRUCTURE_TYPE_HEADLESS_SURFACE_CREATE_INFO_EXT;

VkSurfaceKHR surface;
vkCreateHeadlessSurfaceEXT(instance, &sci, nullptr, &surface);
```

---

## 4. 프레젠테이션 지원 여부 조회

물리 디바이스 내의 모든 큐 패밀리가 서피스 프레젠테이션을 지원하는 것은 아니다. 따라서 서피스 생성 후 큐 패밀리별 지원 여부를 명시적으로 확인해야 한다.

```c
VkBool32 presentSupport = VK_FALSE;
vkGetPhysicalDeviceSurfaceSupportKHR(physicalDevice, queueFamilyIndex, surface, &presentSupport);

if (!presentSupport) {
    // 해당 큐 패밀리는 이 서피스에 대한 프레젠테이션을 지원하지 않음
}
```

> VUID-vkGetPhysicalDeviceSurfaceSupportKHR-queueFamilyIndex-01269: `queueFamilyIndex`는 `vkGetPhysicalDeviceQueueFamilyProperties`가 반환한 `pQueueFamilyPropertyCount` 미만이어야 한다.

**플랫폼별 추가 조회** (서피스 생성 전 호출 가능):

```c
// Win32
vkGetPhysicalDeviceWin32PresentationSupportKHR(physicalDevice, queueFamilyIndex);
// XCB
vkGetPhysicalDeviceXcbPresentationSupportKHR(physicalDevice, queueFamilyIndex, connection, visual_id);
// Wayland
vkGetPhysicalDeviceWaylandPresentationSupportKHR(physicalDevice, queueFamilyIndex, display);
```

이 함수들은 서피스 없이 물리 디바이스와 디스플레이의 일반 호환성을 확인할 수 있다(스펙 37.4.2/37.4.3).

> Android는 모든 물리 디바이스·큐 패밀리가 모든 네이티브 윈도우에 대해 프레젠테이션을 지원하므로 별도 플랫폼 쿼리가 없다(스펙 37.4.1).

**큐 패밀리 구성 시나리오:**
1. **단일 큐 구성**: 그래픽스 연산을 지원하는 큐 패밀리가 프레젠테이션까지 동시에 지원하는 경우. 가장 보편적이며 리소스 소유권 이전이 불필요하여 효율적이다.
2. **분리 큐 구성**: 그래픽스 큐와 프레젠트 큐 패밀리가 분리된 경우. 스왑체인 생성 시 `imageSharingMode`를 `VK_SHARING_MODE_CONCURRENT`로 설정하거나, 프레젠트 전에 명시적인 큐 패밀리 소유권 이전 배리어(Queue Family Ownership Transfer)를 수행해야 한다.

---

### 4.1. 서피스 세부 속성 조회

스왑체인을 생성하기 전 다음 3개 쿼리를 호출하여 서피스 제약 조건을 획득해야 한다.

```c
// 1. 역량 쿼리 (최소/최대 이미지 수, 해상도 범위, 지원 변환 등)
VkSurfaceCapabilitiesKHR capabilities;
vkGetPhysicalDeviceSurfaceCapabilitiesKHR(physicalDevice, surface, &capabilities);

// 2. 지원 포맷 및 색 공간 쿼리
uint32_t formatCount = 0;
vkGetPhysicalDeviceSurfaceFormatsKHR(physicalDevice, surface, &formatCount, nullptr);
std::vector<VkSurfaceFormatKHR> formats(formatCount);
vkGetPhysicalDeviceSurfaceFormatsKHR(physicalDevice, surface, &formatCount, formats.data());

// 3. 지원 프레젠테이션 모드 쿼리
uint32_t presentModeCount = 0;
vkGetPhysicalDeviceSurfacePresentModesKHR(physicalDevice, surface, &presentModeCount, nullptr);
std::vector<VkPresentModeKHR> presentModes(presentModeCount);
vkGetPhysicalDeviceSurfacePresentModesKHR(physicalDevice, surface, &presentModeCount, presentModes.data());
```

> [!NOTE]
> **Win32 extent 제약**: Win32 서피스의 `minImageExtent`, `maxImageExtent`, `currentExtent`는 항상 창 크기와 같다. `currentExtent`의 width와 height는 둘 다 0보다 크거나 둘 다 0이어야 한다(최소화 상태). `VkSwapchainPresentScalingCreateInfoKHR`를 사용하지 않는 한 `imageExtent`는 `currentExtent`와 동일해야 한다.

> [!NOTE]
> **Headless 서피스**: `VK_EXT_headless_surface`로 생성한 서피스에서 `vkQueuePresentKHR`는 no-op이다. 렌더링 결과는 `vkCmdCopyImageToBuffer` 등으로 readback하여 검증한다. Wayland/headless 환경의 `currentExtent`는 항상 `(0xFFFFFFFF, 0xFFFFFFFF)`이므로 Win32처럼 (0,0)으로 최소화 상태를 판별할 수 없다.

---

## 5. 서피스 파괴 및 자원 해제 순서

`VkSurfaceKHR`는 `VkInstance`의 자식 객체다.

```c
// 1. 스왑체인 먼저 파괴
vkDestroySwapchainKHR(device, swapchain, nullptr);

// 2. 서피스 파괴
vkDestroySurfaceKHR(instance, surface, nullptr);

// 3. 인스턴스 파괴
vkDestroyInstance(instance, nullptr);
```

> [!CAUTION]
> 서피스에 바인딩된 스왑체인이 아직 살아있는 상태에서 `vkDestroySurfaceKHR`를 호출하면 미정의 동작이 발생한다. 반드시 스왑체인을 먼저 파괴한 뒤 서피스를 정리해야 한다.

---

## 6. 메시지 펌프와 스레딩 (Win32 데드락 주의)

### 6.1. Win32 `SendMessage` 데드락 메커니즘

Win32 플랫폼에서 다음 Vulkan 스왑체인 함수들은 내부 구현에서 OS 시스템 API인 `SendMessage`를 호출할 수 있다(스펙 37.2 NOTE).
- `vkCreateSwapchainKHR`, `vkDestroySwapchainKHR`
- `vkAcquireNextImageKHR`, `vkAcquireNextImage2KHR`
- `vkQueuePresentKHR`
- `vkReleaseSwapchainImagesKHR`
- `vkAcquireFullScreenExclusiveModeEXT`, `vkReleaseFullScreenExclusiveModeEXT`
- `vkSetHdrMetadataEXT`

`SendMessage`는 대상 윈도우의 메시지 큐를 처리하는 스레드(메시지 펌프 스레드)가 해당 메시지를 디스패치하여 처리를 마칠 때까지 **호출 스레드를 동기적으로 블록**시킨다.

```
[렌더 스레드]                                     [메인 메시지 펌프 스레드]
vkQueuePresentKHR 호출
  └─> 내부 SendMessage(hWnd, ...) 호출 (블록됨) ───> 창 메시지 큐에 메시지 도착
      ▲
      │ (메인 스레드가 멈춰 있으면)
      └────────────────────────────────────────── 영구 데드락 발생!
```

따라서 렌더 스레드가 별도로 존재할 때 메인 스레드가 메시지 펌프 루프를 돌지 않고 멈춰 있거나 블로킹 상태에 빠지면 애플리케이션 전체가 영구 데드락에 걸린다.

**자주 빠지는 시나리오:**

- 렌더 스레드만 있고 메시지 펌프 스레드가 없는 구조 — Vulkan 호출이 `SendMessage`로 자기 자신 또는 정지된 스레드를 깨우려다 deadlock.
- macOS의 `dispatchMain()` 또는 Linux의 `wl_display_roundtrip` 대신 워커 스레드에서 Vulkan 호출만 하는 경우 — OS 메시지 큐에 도달 불가하여 deadlock.
- 백그라운드 스레드에서 `vkQueuePresentKHR` 호출 + 메인 스레드가 `WM_PAINT` 등 OS 메시지 처리 중이면 정상. 펌프가 멈춰 있으면 deadlock.

---

### 6.2. 권장 메시지 펌프 아키텍처

#### 패턴 A: 단일 스레드 구조 (가장 안전하고 단순함)
메시지 펌프와 Vulkan 렌더링 호출을 동일한 메인 스레드에서 차례로 실행한다.

```c
MSG msg{};
while (running) {
    while (PeekMessage(&msg, nullptr, 0, 0, PM_REMOVE)) {
        if (msg.message == WM_QUIT) {
            running = false;
            break;
        }
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    if (running) {
        drawFrame();
    }
}
```

#### 패턴 B: 멀티스레드 분리 구조 (CPU 사용률 최적화)
메인 스레드는 `MsgWaitForMultipleObjects`를 사용하여 창 메시지가 도착했을 때만 즉시 깨어나 처리하고, 렌더 스레드는 독립적으로 렌더 루프를 실행한다.

```c
// 메인 스레드 (메시지 펌프 전담, CPU 0% 대기)
void messagePumpThread() {
    MSG msg;
    while (running) {
        DWORD result = MsgWaitForMultipleObjects(0, nullptr, FALSE, INFINITE, QS_ALLINPUT);
        if (result == WAIT_OBJECT_0) {
            while (PeekMessage(&msg, nullptr, 0, 0, PM_REMOVE)) {
                TranslateMessage(&msg);
                DispatchMessage(&msg);
            }
        }
    }
}

// 렌더 스레드
void renderThread() {
    while (running) {
        drawFrame(); // vkQueuePresentKHR 호출 시 SendMessage가 펌프 스레드를 깨움
    }
}
```

---

## 7. 플랫폼별 메시지 펌프 패턴

각 OS마다 메시지/이벤트 큐 처리가 다르다. Vulkan은 OS 메시지 큐에 직접 접근하지 않으며, 일반적으로 OS API로 처리한 후 펌프가 도는 스레드에서 Vulkan을 호출한다.

### 7.1. X11 (XCB)

X11의 메시지 루프는 `xcb_connection_t`에서 이벤트 폴링.

**단일 스레드 (권장):**

```c
xcb_generic_event_t* event;
while (running) {
    while ((event = xcb_poll_for_event(connection)) != nullptr) {
        handleX11Event(event);
        free(event);
    }
    RenderFrame();
}
```

> `xcb_wait_for_event`는 다른 스레드에서 호출할 수 없다(XCB는 thread-safe하지 않음). 분리 스레드 구조에서는 `eventfd` 또는 pipe로 깨우는 방식을 사용한다.

Vulkan + XCB: Win32의 `SendMessage` 같은 cross-thread 이슈 없음.

### 7.2. Wayland

Wayland는 비동기 프로토콜 — 클라이언트가 직접 메시지 큐를 관리한다.

```c
while (running) {
    wl_display_dispatch_pending(display);
    wl_display_flush(display);
    RenderFrame();
}
```

- Wayland는 본질적으로 `VK_PRESENT_MODE_MAILBOX_KHR` 모드(스펙 §37.4 Issue 2).
- `libwayland-client`는 thread-safe하지 않으므로 **반드시 단일 스레드**에서 호출.

### 7.3. Android (Native Activity)

Android 순수 네이티브 Vulkan 앱은 `android_native_app_glue` 기반 Native Activity를 사용한다.

**스레드 구조:**

| 스레드 | 역할 | OS API |
|--------|------|--------|
| 메인 스레드 (=UI 스레드) | `ANativeActivity` 콜백, `ALooper_pollOnce` 펌프, 렌더 스레드 시작/정지 | `ALooper`, `ANativeActivity_*` |
| 렌더 스레드 | `vkAcquireNextImageKHR`, `vkQueueSubmit`, `vkQueuePresentKHR` | `pthread_create` |

**ANativeWindow 라이프사이클:**

| 이벤트 | 콜백 | 해야 할 일 |
|--------|------|-----------|
| 윈도우 생성됨 | `onNativeWindowCreated` | window 보관, 렌더 스레드 시작 |
| 윈도우 파괴됨 | `onNativeWindowDestroyed` | 렌더 스레드 정지, 스왑체인 destroy, `window = nullptr` |
| 일시정지 | `onPause` | 렌더 스레드 정지 + `vkDeviceWaitIdle` |
| 재개 | `onResume` | 렌더 스레드 다시 시작 |

**핵심 안전성:**
- 모든 물리 디바이스·큐 패밀리가 모든 네이티브 윈도우에 대해 프레젠테이션 지원(스펙 37.4.1). 별도 쿼리 불필요.
- `ANativeWindow` 해제는 메인 스레드에서만 가능. 렌더 스레드에서 `ANativeWindow_release` 호출 시 UB.
- Win32의 `SendMessage` 같은 cross-thread deadlock 없음.

> VUID-VkAndroidSurfaceCreateInfoKHR-window-01248: `window`는 유효한 `ANativeWindow`를 가리켜야 한다.

### 7.4. macOS (MoltenVK)

macOS의 메시지 루프는 `NSRunLoop`. `NSApplication` 또는 수동 펌프.

**단일 스레드 + 수동 펌프:**

```objc
while (running) {
    NSEvent* event = [NSApp nextEventMatchingMask:NSEventMaskAny
        untilDate:[NSDate distantFuture]
        inMode:NSDefaultRunLoopMode dequeue:YES];
    if (event) [NSApp sendEvent:event];
    RenderFrame();
}
```

- `VK_EXT_metal_surface`(`CAMetalLayer*`) 사용. 구식 `VK_MVK_macos_surface`는 폐기 예정.
- NSView는 **메인 스레드에서만** 안전.
- `dispatchMain()`은 blocking이라 렌더 스레드에서 호출 시 메시지 처리 불가.
- Win32의 `SendMessage` 동등 이슈 없음.

### 7.5. iOS (MoltenVK)

iOS는 UIKit 메인 스레드 강제. 모든 UI 이벤트는 메인 스레드에서 처리.

- `VK_PRESENT_MODE_MAILBOX_KHR` 강제(VSync 필수).
- `CADisplayLink`로 vsync 동기화.
- cross-thread deadlock 패턴 없음. 단 UIKit은 반드시 메인 스레드.

### 7.6. 정리표

| 플랫폼 | 메시지 펌프 함수 | Single-thread 권장 | Cross-thread 안전성 |
|--------|------------------|---------------------|----------------------|
| Win32 | `PeekMessage` / `MsgWaitForMultipleObjects` | ✅ | `SendMessage` deadlock 함정 |
| X11 (XCB) | `xcb_poll_for_event` | ✅ | XCB thread-safe 아님 |
| Wayland | `wl_display_dispatch_pending` | ✅ (필수) | libwayland thread-safe 아님 |
| Android | `ALooper_pollOnce` (UI) | ❌ (UI=메인, 렌더=별도) | ✓ 안전 |
| macOS | `NSApp run` / 수동 펌프 | ✅ | NSView는 메인 스레드만 |
| iOS | UIKit main loop / `CADisplayLink` | ✅ (UI=메인, 렌더=백그라운드) | ✓ 안전 |

---

## 8. 서피스리스 컨텍스트 (Surfaceless Context)

Vulkan 1.3 코어 또는 `VK_KHR_surfaceless_context` 확장이 활성화된 환경에서는 화면 출력용 윈도우 없이도 디바이스를 초기화하여 순수 연산(Compute-only)이나 오프스크린 렌더링 작업을 수행할 수 있다.

스왑체인이 필요 없는 파이프라인이라면 `VkSurfaceKHR`를 아예 생성하지 않고도 프레임버퍼 이미지를 메모리에 렌더링한 후 버퍼로 복사(`vkCmdCopyImageToBuffer`)하여 디스크에 저장하거나 네트워크로 전송할 수 있다.

---

## 9. 주요 점검 사항

### 9.1. 초기화 및 생성
- [ ] `VK_KHR_surface` 및 대상 OS용 플랫폼 확장을 인스턴스 확장 목록에 활성화했는지 확인
- [ ] Win32: `hwnd`가 유효한 윈도우 핸들인지 확인 (VUID-VkWin32SurfaceCreateInfoKHR-hwnd-01308)
- [ ] Win32: `hinstance`가 유효한 인스턴스 핸들인지 확인 (VUID-VkWin32SurfaceCreateInfoKHR-hinstance-01307)
- [ ] Android: `ANativeWindow`가 null 또는 해제된 객체가 아닌지 확인 (VUID-VkAndroidSurfaceCreateInfoKHR-window-01248)
- [ ] `vkGetPhysicalDeviceSurfaceSupportKHR`의 `queueFamilyIndex`가 `pQueueFamilyPropertyCount` 미만인지 확인 (VUID-vkGetPhysicalDeviceSurfaceSupportKHR-queueFamilyIndex-01269)

### 9.2. 스레딩 및 메시지 펌프
- [ ] Win32 환경에서 렌더 스레드가 별도로 동작할 때 메인 스레드의 메시지 펌프가 상시 활성화되어 데드락을 방지하는지 확인
- [ ] 창 최소화 이벤트 발생 시 렌더 루프를 일시 정지하도록 처리했는지 확인
- [ ] 종료 시 스왑체인 -> 서피스 -> 인스턴스 순서로 역순 파괴하는지 확인
