---
title: Windowing / Surface
slug: wsi-surface
---

## 소개

**Windowing / Surface (WSI — Window System Integration)**는 Vulkan을 **OS 윈도우 시스템**과 연결하는 다리다. `VkSurfaceKHR`는 **OS의 윈도우 핸들**(Win32 HWND, XCB wl_surface, Wayland surface, Android ANativeWindow 등)을 **Vulkan이 이해하는 추상 객체**로 감싼다.

> **용어 정리**
> - **Surface (`VkSurfaceKHR`)**: OS 윈도우 핸들을 감싼 **플랫폼 중립 객체**.
> - **WSI (Window System Integration)**: Vulkan과 윈도우 시스템을 잇는 계층. 플랫폼별 `VK_KHR_*_surface` 확장으로 노출.
> - **Presentation Engine**: surface를 **실제로 화면에 그리는** OS/디스플레이 서버 측 컴포넌트. Vulkan은 직접 알지 못함.
> - **Headless Surface**: 윈도우 없는 surface. `VK_EXT_headless_surface`로 생성. 테스트/오프스크린 렌더.
> - **Surfaceless Context**: surface 없이 rendering. `VK_KHR_surfaceless_context` 또는 `VK_EXT_surface_maintenance1`로 surface 없이 swapchain 생성.

이 문서는 **surface 생성 → present 지원 조회 → 헤드리스/오프스크린** 흐름을 다룬다. `swapchain` 문서와 함께 보면 화면 출력 전체가 이해됨.

---

## 1. 왜 필요한가

Vulkan은 **플랫폼 중립** 그래픽 API. **윈도우 시스템**은 **플랫폼 의존** (Win32 / X11 / Wayland / Android / iOS / macOS / Fuchsia / QNX / GGP / VI / OHOS / Metal).

WSI가 이 둘을 잇는다:

```
[OS 윈도우]  ← WSI →  [Vulkan Surface]  ← VkSwapchainKHR  ← [렌더링 결과]
```

| 단계 | WSI 역할 |
|------|----------|
| 윈도우 생성 | OS API (Win32 `CreateWindowEx`, XCB `xcb_create_window`, Wayland `wl_compositor_create_surface`, Android `ANativeWindow`) |
| Vulkan surface 생성 | `vkCreate*SurfaceKHR(...)` — OS 핸들을 Vulkan 객체로 감쌈 |
| Present 지원 조회 | `vkGetPhysicalDeviceSurfaceSupportKHR(physicalDevice, queueFamily, surface, ...)` |
| Swapchain 생성 | `vkCreateSwapchainKHR` (surface 필요) — 별도 문서 |
| Present | `vkQueuePresentKHR` (OS/디스플레이 서버가 처리) |
| 윈도우 이벤트 | OS API (Win32 메시지 펌프, XCB 이벤트 루프 등) — Vulkan은 모름 |

**핵심 포인트:**

- Vulkan은 **윈도우 이벤트를 알지 못함**. 사용자는 OS API로 메시지 펌프를 돌려야 함.
- `VkSurfaceKHR`는 **플랫폼 중립 추상화**라서 코드를 Win32/XCB/Wayland에 따라 다르게 작성해도 같은 swapchain 흐름 재사용.
- `VK_KHR_surface`는 **인스턴스 레벨** 확장. instance 생성 시 enable 필요.

---

## 2. 플랫폼별 extension 매트릭스

> **스펙 원문 (Appendix H, Table 131)** — Window System Extensions and Headers

| Extension | 플랫폼 | 헤더 | 매크로 |
|-----------|--------|------|--------|
| `VK_KHR_win32_surface` | Microsoft Windows | `<windows.h>` | `VK_USE_PLATFORM_WIN32_KHR` |
| `VK_KHR_xcb_surface` | X11 (XCB) | `<xcb/xcb.h>` | `VK_USE_PLATFORM_XCB_KHR` |
| `VK_KHR_xlib_surface` | X11 (Xlib) | `<X11/Xlib.h>` | `VK_USE_PLATFORM_XLIB_KHR` |
| `VK_KHR_wayland_surface` | Wayland | `<wayland-client.h>` | `VK_USE_PLATFORM_WAYLAND_KHR` |
| `VK_KHR_android_surface` | Android | (없음) | `VK_USE_PLATFORM_ANDROID_KHR` |
| `VK_MVK_macos_surface` | macOS (MoltenVK) | (없음) | `VK_USE_PLATFORM_MACOS_MVK` |
| `VK_MVK_ios_surface` | iOS (MoltenVK) | (없음) | `VK_USE_PLATFORM_IOS_MVK` |
| `VK_EXT_metal_surface` | Metal on CoreAnimation | (없음) | `VK_USE_PLATFORM_METAL_EXT` |
| `VK_EXT_headless_surface` | (없음, 오프스크린) | (없음) | (헤더 없음) |
| `VK_OHOS_surface` | OpenHarmony | (없음) | `VK_USE_PLATFORM_OHOS` |
| `VK_QNX_screen_surface` | QNX Screen | `<screen/screen.h>` | `VK_USE_PLATFORM_SCREEN_QNX` |
| `VK_FUCHSIA_imagepipe_surface` | Fuchsia | `<zircon/types.h>` | `VK_USE_PLATFORM_FUCHSIA` |
| `VK_GGP_stream_descriptor_surface` | Google Games Platform | `<ggp_c/vulkan_types.h>` | `VK_USE_PLATFORM_GGP` |
| `VK_NN_vi_surface` | VI (Nintendo Switch 호환?) | (없음) | `VK_USE_PLATFORM_VI_NN` |
| `VK_EXT_directfb_surface` | DirectFB | `<directfb/directfb.h>` | `VK_USE_PLATFORM_DIRECTFB_EXT` |

**매크로 의미**: `vulkan.h`가 해당 플랫폼 헤더를 include할지 결정. 빌드 시스템에서 `-DVK_USE_PLATFORM_WIN32_KHR` 같은 식으로 정의.

**Instance enable:**

```c
const char* instanceExtensions[] = {
    VK_KHR_SURFACE_EXTENSION_NAME,                // 공통
    VK_KHR_WIN32_SURFACE_EXTENSION_NAME,          // 또는 VK_KHR_XCB_SURFACE_EXTENSION_NAME 등
};
VkInstanceCreateInfo ici{};
ici.enabledExtensionCount = 2;
ici.ppEnabledExtensionNames = instanceExtensions;
```

---

## 3. Surface 생성

### 3.1. Win32

```c
// vulkan_win32.h + <windows.h> 필요
VkWin32SurfaceCreateInfoKHR sci{};
sci.sType     = VK_STRUCTURE_TYPE_WIN32_SURFACE_CREATE_INFO_KHR;
sci.hinstance = hInstance;  // 보통 GetModuleHandle(NULL)
sci.hwnd      = hWnd;       // CreateWindowEx로 만든 윈도우

VkSurfaceKHR surface;
vkCreateWin32SurfaceKHR(instance, &sci, nullptr, &surface);
```

> **스펙 원문 (VUID-VkWin32SurfaceCreateInfoKHR-hinstance-01307)** `hinstance` must be a valid Win32 `HINSTANCE`.
> **(VUID-VkWin32SurfaceCreateInfoKHR-hwnd-01308)** `hwnd` must be a valid Win32 `HWND`.

### 3.2. XCB (X11)

```c
#include <xcb/xcb.h>

VkXcbSurfaceCreateInfoKHR sci{};
sci.sType      = VK_STRUCTURE_TYPE_XCB_SURFACE_CREATE_INFO_KHR;
sci.connection = xcb_connection;  // xcb_connect()
sci.window     = xcb_window_id;    // xcb_generate_id()

VkSurfaceKHR surface;
vkCreateXcbSurfaceKHR(instance, &sci, nullptr, &surface);
```

### 3.3. Wayland

```c
#include <wayland-client.h>

VkWaylandSurfaceCreateInfoKHR sci{};
sci.sType  = VK_STRUCTURE_TYPE_WAYLAND_SURFACE_CREATE_INFO_KHR;
sci.display = wl_display;       // wl_display_connect()
sci.surface = wl_surface;       // wl_compositor_create_surface()

VkSurfaceKHR surface;
vkCreateWaylandSurfaceKHR(instance, &sci, nullptr, &surface);
```

### 3.4. Android

```c
#include <android/native_window.h>  // 또는 vulkan_android.h에 incomplete type만

VkAndroidSurfaceCreateInfoKHR sci{};
sci.sType  = VK_STRUCTURE_TYPE_ANDROID_SURFACE_CREATE_INFO_KHR;
sci.window = ANativeWindow_fromSurface(env, surface);  // Java Surface → ANativeWindow

VkSurfaceKHR vkSurface;
vkCreateAndroidSurfaceKHR(instance, &sci, nullptr, &vkSurface);
```

> **스펙 원문 (VUID-VkAndroidSurfaceCreateInfoKHR-window-01248)** `window` must point to a valid Android `ANativeWindow`.

### 3.5. macOS / iOS (MoltenVK)

```c
// macOS
VkMacOSSurfaceCreateInfoMVK sci{};
sci.sType = VK_STRUCTURE_TYPE_MACOS_SURFACE_CREATE_INFO_MVK;
sci.pView = (void*)nsview;  // NSView*

// iOS
VkIOSSurfaceCreateInfoMVK sci{};
sci.sType = VK_STRUCTURE_TYPE_IOS_SURFACE_CREATE_INFO_MVK;
sci.pView = (void*)uiview;  // UIView*
```

### 3.6. Headless surface (오프스크린)

```c
// VK_EXT_headless_surface
VkHeadlessSurfaceCreateInfoEXT sci{};
sci.sType = VK_STRUCTURE_TYPE_HEADLESS_SURFACE_CREATE_INFO_EXT;

VkSurfaceKHR surface;
vkCreateHeadlessSurfaceEXT(instance, &sci, nullptr, &surface);
```

> **용도** 렌더링/present 테스트, 오프스크린 캡처, headless 서버. `vkCreateSwapchainKHR`로 오프스크린 렌더 후 `vkQueuePresentKHR`는 `VK_ERROR_OUT_OF_DATE_KHR` 또는 `VK_ERROR_SURFACE_LOST_KHR` 반환 — present는 무시하고 image를 readback해서 검증.

---

## 4. Present 지원 조회

> **스펙 원문 (스펙 37.4)** "Not all physical devices will include WSI support. Within a physical device, not all queue families will support presentation. WSI support and compatibility can be determined in a platform-neutral manner (which determines support for presentation to a particular surface object)..."

```c
// 플랫폼 중립: 큐 패밀리 × surface
VkBool32 supported;
vkGetPhysicalDeviceSurfaceSupportKHR(physicalDevice,
    queueFamilyIndex, surface, &supported);

if (!supported) {
    // 이 큐 패밀리는 이 surface에 present 불가
    // → 다른 큐 패밀리 사용 또는 별도 present 큐 필요
}
```

**선택 전략:**

| 큐 구조 | 권장 |
|---------|------|
| graphics 큐가 present 지원 | graphics 큐 하나로 통합 (가장 단순) |
| graphics + 별도 present 큐 | 다중 큐, 동기는 semaphore (별도 큐 = 더 안전) |
| compute 전용 디바이스 | 별도 present 큐 필수 |

> **스펙 원문 (VUID-vkGetPhysicalDeviceSurfaceSupportKHR-queueFamilyIndex-01269)** `queueFamilyIndex` must be less than `pQueueFamilyPropertyCount` returned by `vkGetPhysicalDeviceQueueFamilyProperties`.

**플랫폼별 추가 조회** (생성 전 확인 가능):

```c
// Win32
vkGetPhysicalDeviceWin32PresentationSupportKHR(physicalDevice, queueFamily);
// XCB
vkGetPhysicalDeviceXcbPresentationSupportKHR(physicalDevice, queueFamily, connection, visual_id);
// Wayland
vkGetPhysicalDeviceWaylandPresentationSupportKHR(physicalDevice, queueFamily, display);
```

이 함수들은 **surface 없이** 물리 디바이스 × 디스플레이의 일반 호환성 확인.

> **NOTE (스펙 37.4.1)** "On Android, all physical devices and queue families must be capable of presentation with any native window. As a result there is no Android-specific query for these capabilities."
>> Android는 별도 플랫폼 쿼리 없음. `vkGetPhysicalDeviceSurfaceSupportKHR`만으로 충분.

### 4.4. Surface Capabilities / Formats / Present Modes 조회

present 지원 여부 외에도 **이 surface로 할 수 있는 것**을 조회한다. swapchain 생성 전 반드시 확인.

```c
// capabilities
VkSurfaceCapabilitiesKHR caps;
vkGetPhysicalDeviceSurfaceCapabilitiesKHR(physDev, surface, &caps);
// caps.minImageCount, maxImageCount → swapchain image 수
// caps.currentExtent, minImageExtent, maxImageExtent → 크기 범위
// caps.supportedTransforms, supportedCompositeAlpha, supportedUsageFlags

// formats + color spaces
uint32_t fmtCount;
vkGetPhysicalDeviceSurfaceFormatsKHR(physDev, surface, &fmtCount, nullptr);
std::vector<VkSurfaceFormatKHR> formats(fmtCount);
vkGetPhysicalDeviceSurfaceFormatsKHR(physDev, surface, &fmtCount, formats.data());
// formats[i].format ↔ VK_FORMAT_B8G8R8A8_SRGB 등
// formats[i].colorSpace ↔ VK_COLOR_SPACE_SRGB_NONLINEAR_KHR 등

// present modes
uint32_t modeCount;
vkGetPhysicalDeviceSurfacePresentModesKHR(physDev, surface, &modeCount, nullptr);
std::vector<VkPresentModeKHR> modes(modeCount);
vkGetPhysicalDeviceSurfacePresentModesKHR(physDev, surface, &modeCount, modes.data());
// FIFO는 항상 지원, MAILBOX/IMMEDIATE는 조건부
```

> **선택 가이드** — `swapchain.md`의 §2, §3 참고. capabilities/formats/modes 값은 swapchain 생성 시 그대로 사용한다.

---

## 5. Surface cleanup

```c
vkDestroySurfaceKHR(instance, surface, nullptr);
```

- Surface는 **instance의 자식**. instance destroy 시 자동 정리.
- Surface가 destroy되어도 그 surface로 만든 swapchain은 **invalid**. `vkDestroySwapchainKHR` 먼저 호출.

---

## 6. 자주 빠지는 주의사항 모음

### 6.1. Instance / extension

- [ ] `VK_KHR_SURFACE_EXTENSION_NAME`을 instance extensions에 안 넣음 → `vkCreate*SurfaceKHR`의 entry point가 nullptr.
- [ ] 플랫폼별 extension 미활성 (Win32인데 `VK_KHR_XCB_SURFACE_EXTENSION_NAME` 등 잘못 켬).
- [ ] `VK_USE_PLATFORM_*_KHR` 매크로 미정의 → `vulkan.h`가 헤더 include 안 해서 `HWND` 등 타입 미정의.

### 6.2. Surface 생성

- [ ] `hwnd`가 파괴된 윈도우 (VUID-VkWin32SurfaceCreateInfoKHR-hwnd-01308).
- [ ] `hinstance`가 유효하지 않음 (VUID-hinstance-01307).
- [ ] Android `ANativeWindow`가 null 또는 해제된 객체 (VUID-window-01248).
- [ ] `pNext`에 다른 구조체 체이닝 (VUID-pNext-pNext = NULL 강제).
- [ ] `flags`에 임의 값 (보통 reserved, 0이어야 함).

### 6.3. Present 지원 / 큐 선택

- [ ] graphics 큐가 present 미지원 + 별도 present 큐 없음 → 모든 큐 옵션 실패.
- [ ] `vkGetPhysicalDeviceSurfaceSupportKHR`의 `queueFamilyIndex`가 `pQueueFamilyPropertyCount` 이상 (VUID-queueFamilyIndex-01269).
- [ ] Surface와 `vkCreateSwapchainKHR`/present 호출 시 같은 instance (VUID-commonparent).
- [ ] Surface 파괴 후 swapchain/present 호출 → UB.

### 6.4. 메시지 펌프 / 스레딩 (Win32 주의)

> **스펙 원문 (Win32 SendMessage NOTE)** "Some Vulkan functions may call the `SendMessage` system API when interacting with a `VkSurfaceKHR` through a `VkSwapchainKHR`. In a multithreaded environment, calling `SendMessage` from a thread that is not the thread associated with `pCreateInfo->hwnd` will block until the application has processed the window message. Thus, applications should either call these Vulkan functions on the message pump thread, or make sure their message pump is actively running. Failing to do so may result in deadlocks."

**무슨 일이 일어나는가**

Win32 surface를 가진 swapchain 관련 Vulkan 함수는 내부에서 OS의 `SendMessage` API를 호출한다. `SendMessage`는 **호출한 스레드에서 동기적으로** 메시지 처리를 기다린다. 메시지를 처리할 스레드(=메시지 펌프)가 그 메시지를 받아야 `SendMessage`가 반환된다.

| 스레드 구조 | 동작 | 결과 |
|------------|------|------|
| 단일 스레드 = 메시지 펌프 | `PeekMessage` → Vulkan 호출 → `PeekMessage` 루프 | 정상 |
| 렌더 스레드 A에서 Vulkan 호출 + 메시지 펌프 스레드 B는 **블록 또는 정지** | `SendMessage`가 B에서 메시지 처리를 기다림 | **deadlock** |
| 메시지 펌프가 B에 있고 `GetMessage` (블로킹)로 멈춤 | A에서 Vulkan 호출 시 `SendMessage`가 B의 메시지 큐에 메시지 넣음 → B가 깨서 처리 | 정상 (B는 깨어있음) |
| 두 스레드 A, B가 같은 surface에 동시에 `vkQueuePresentKHR` / `vkAcquireNextImageKHR` 호출 | 같은 surface 자원에 동시 접근 | UB / 드라이버 에러 |

**핵심: 메시지 펌프를 도는 스레드(=윈도우를 가진 스레드)가 살아있어야 함.**

**영향받는 함수** (이 중 하나라도 호출 시 메시지 펌프 필요):

- `vkCreateSwapchainKHR` / `vkDestroySwapchainKHR`
- `vkAcquireNextImageKHR` / `vkAcquireNextImage2KHR`
- `vkQueuePresentKHR`
- `vkReleaseSwapchainImagesKHR`
- `vkAcquireFullScreenExclusiveModeEXT` / `vkReleaseFullScreenExclusiveModeEXT`
- `vkSetHdrMetadataEXT`

> 이 함수는 **렌더 스레드가 아니라 메시지 펌프가 도는 스레드**에서 호출하거나, 메시지 펌프가 항상 깨어있는 상태(`PeekMessage` 비블로킹 루프 등)여야 한다.

**자주 빠지는 실수 (구체적 시나리오):**

- [ ] **렌더 스레드만 있고 메시지 펌프 스레드가 없는 구조** — Vulkan 호출이 `SendMessage`로 자기 자신 또는 정지된 스레드를 깨우려다 deadlock.
- [ ] **렌더 스레드 A + 메시지 펌프 스레드 B**인데 B가 `GetMessage`(블로킹)로 멈춤 + A에서 Vulkan 호출 — `SendMessage`가 B의 큐에 메시지 넣고 B가 깨어남. 이 케이스는 정상.
- [ ] **메시지 펌프 스레드 B + 별도 워커 스레드 C**가 같은 surface를 동시에 — `vkQueuePresentKHR`가 A에서 호출되고 동시에 `vkAcquireNextImageKHR`가 C에서 호출되는 등 race. surface에 대한 외부 동기화 필요.
- [ ] **macOS의 `dispatchMain()` 또는 Linux의 `wl_display_roundtrip`** 같은 메시지 펌프 대신, 워커 스레드에서 Vulkan 호출만 — `SendMessage`가 메인 스레드 메시지 큐에 도달 불가. deadlock.
- [ ] **백그라운드 스레드에서 `vkQueuePresentKHR` 호출** + 메인 스레드가 `WM_PAINT`나 다른 OS 메시지 처리 중 — 메인 스레드가 펌프 도는 중이면 정상. 아니라면 deadlock.

### 6.5. Win32 surface 특이사항

> **스펙 원문 (Win32 NOTE)** "With Win32, `minImageExtent`, `maxImageExtent`, and `currentExtent` must always equal the window size. The `currentExtent` of a Win32 surface must have both width and height greater than 0, or both of them 0."

- [ ] Win32 surface의 `currentExtent.width == 0` 또는 `height == 0` (minimized) → swapchain 생성 불가.
- [ ] `currentExtent`와 다른 `imageExtent`로 swapchain 생성 시도 → Win32에서는 불가 (다른 플랫폼은 가능할 수도).

> **스펙 원문 (Win32 NOTE)** "Due to above restrictions, unless `VkSwapchainPresentScalingCreateInfoKHR` is used ... it is only possible to create a new swapchain on this platform with `imageExtent` being equal to the `currentExtent`."

### 6.6. Headless / 오프스크린

- [ ] `VK_EXT_headless_surface` 미활성 + `vkCreateHeadlessSurfaceEXT` 호출 → entry point nullptr.
- [ ] headless surface에서 `vkQueuePresentKHR` 호출 → present 무시. image를 `vkCmdCopyImageToBuffer` 등으로 readback.

### 6.7. 일반 / 실전

- [ ] 여러 윈도우 → 여러 surface → **각 surface마다 별도 swapchain** + 별도 present 호출.
- [ ] Surface를 너무 늦게 destroy (instance destroy 직전까지 살아있어야 함).
- [ ] Vulkan 로드(`vkGetInstanceProcAddr`)를 surface 생성 전에 호출. loader가 surface extension의 entry point를 채워야 함.
- [ ] Android `Java Surface`를 ANativeWindow로 변환한 후 `vkCreateAndroidSurfaceKHR`에 넘기는 순서. `ANativeWindow_acquire` / `ANativeWindow_release` 수명 관리.
- [ ] macOS MoltenVK 사용 시 `NSView` 변경(예: 윈도우 리사이즈) 후 `VK_MVK_macos_surface` 업데이트 필요할 수 있음 (MoltenVK 문서 참고).

---

## 7. 플랫폼별 메시지 펌프 패턴

각 OS마다 메시지/이벤트 큐 처리가 다르다. Vulkan은 **OS 메시지 큐에 직접 접근하지 않고**, 일반적으로 OS API로 처리한 후 펌프가 도는 스레드에서 Vulkan을 호출한다.

### 7.1. Win32

**Win32만 특별**: Vulkan swapchain 함수가 내부적으로 `SendMessage` API를 호출한다. 메시지를 처리할 스레드가 없으면 deadlock. 다른 OS에는 이 함정 없음.

> **스펙 원문 (Win32 SendMessage NOTE)** "Some Vulkan functions may call the `SendMessage` system API when interacting with a `VkSurfaceKHR` through a `VkSwapchainKHR`. In a multithreaded environment, calling `SendMessage` from a thread that is not the thread associated with `pCreateInfo->hwnd` will block until the application has processed the window message. Thus, applications should either call these Vulkan functions on the message pump thread, or make sure their message pump is actively running. Failing to do so may result in deadlocks."

영향받는 함수: `vkCreateSwapchainKHR`, `vkDestroySwapchainKHR`, `vkAcquireNextImageKHR`/`2KHR`, `vkQueuePresentKHR`, `vkReleaseSwapchainImagesKHR`, `vkAcquireFullScreenExclusiveModeEXT`/`Release`, `vkSetHdrMetadataEXT`.

**패턴 비교**:

| 패턴 | 안전성 | 비고 |
|------|--------|------|
| A. **모든 Vulkan 호출을 메시지 펌프 스레드에서** | ✅ 가장 안전 | 작은 프로젝트에 적합. 펌프 루프 한 번에 렌더 1프레임. |
| B. 메시지 펌프 스레드(B) + 렌더 스레드(A) 분리, B는 `MsgWaitForMultipleObjects` | ✅ 안전 (CPU 0%) | OS 레벨 sleep. A의 `vkQueuePresentKHR` → `SendMessage`로 B 깨움. |
| C. 메시지 펌프 스레드(B) + 렌더 스레드(A) 분리, B는 `GetMessage` 블로킹 | ⚠ 함정 | 동작은 하지만 A는 B가 깨어날 때까지 블로킹 → 프레임 스파이크. |
| D. **렌더 스레드만 있고 메시지 펌프가 도는 스레드 없음** | ❌ deadlock | A의 Vulkan 호출이 `SendMessage` 호출하지만 처리할 스레드 없음. |
| E. **별도 워커 스레드 2개 (펌프도 렌더도 아님)** | ❌ deadlock | 둘 다 OS 메시지 큐에 도달 불가. |

**패턴 A — 단일 스레드 (가장 안전)**:

```c
MSG msg;
while (running) {
    // 메시지 펌프 (비블로킹으로 모든 메시지 처리)
    while (PeekMessage(&msg, nullptr, 0, 0, PM_REMOVE)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    // 같은 스레드에서 렌더
    RenderFrame();
}
```

**패턴 B — 분리 스레드 (B는 이벤트 기반 펌프, CPU 0%)**:

`Sleep(1)`은 1ms마다 깨우므로 CPU를 깨어있게 만들고, 진정한 sleep이 아님. **Win32의 `MsgWaitForMultipleObjects`**를 쓰면 메시지가 도착할 때까지 스레드가 OS 레벨에서 sleep (CPU 0%).

```c
// 메시지 펌프 스레드 — CPU 0% 이벤트 기반
std::thread pumpThread([] {
    MSG msg;
    while (running) {
        // QS_ALLINPUT: 모든 입력 메시지 (WM_* + 큐 시그널)
        // INFINITE: 메시지 도착 전까지 sleep
        DWORD result = MsgWaitForMultipleObjects(
            0, nullptr, FALSE,
            INFINITE,
            QS_ALLINPUT
        );
        if (result == WAIT_OBJECT_0) {
            // 큐에 메시지 도착 → 모두 처리
            while (PeekMessage(&msg, nullptr, 0, 0, PM_REMOVE)) {
                TranslateMessage(&msg);
                DispatchMessage(&msg);
            }
        }
        // 다른 return 값 (WAIT_TIMEOUT 등): 보통 무시
    }
});

// 렌더 스레드 — 큐에 메시지 보내면 펌프 스레드가 깨어남
std::thread renderThread([] {
    while (running) {
        vkWaitForFences(device, 1, &fence, VK_TRUE, UINT64_MAX);
        uint32_t imgIdx;
        vkAcquireNextImageKHR(device, swapchain, UINT64_MAX, sem, nullptr, &imgIdx);
        // ... record ...
        vkQueueSubmit(gfxQueue, 1, &submit, fence);
        vkQueuePresentKHR(presentQueue, &presentInfo);
        // ↑ vkQueuePresentKHR가 내부에서 SendMessage → 펌프 스레드 깨움
    }
});
```

**`MsgWaitForMultipleObjects`의 장점**:
- 메시지 도착 전까지 **OS 레벨 sleep** (CPU 0%)
- `SendMessage`로 깨울 수 있음 → 렌더 스레드에서 Vulkan 호출 시 펌프 스레드가 즉시 깨어남
- 1ms 깨어있기 같은 busy-wait 없음

**패턴 C (함정)** — B가 `GetMessage` 블로킹:

```c
// 위험: A에서 Vulkan 호출 → SendMessage → B가 깨워야 하는데
// B는 깨어있지만 다른 메시지 처리 중일 수 있음. → 일시 정지.
std::thread pumpThread([] {
    MSG msg;
    while (GetMessage(&msg, nullptr, 0, 0)) {  // ← 블로킹
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
});
// → 일단 동작은 하지만 B가 다른 작업 중이면 A가 대기. fps 드랍.
```

### 7.2. X11 (XCB)

X11의 메시지 루프는 `xcb_connection_t`에서 이벤트 폴링. 두 가지 모드:

**Blocking 모드 (단일 스레드)**:

```c
xcb_generic_event_t* event;
while (running) {
    // XCB_POLL_FOR_EVENT: 큐 비면 nullptr 즉시 반환
    while ((event = xcb_poll_for_event(connection)) != nullptr) {
        handleX11Event(event);
        free(event);
    }
    RenderFrame();
}
```

**Event-based + 분리 스레드** — `eventfd` 또는 pipe로 깨우기:

```c
int eventFd = eventfd(0, EFD_NONBLOCK);  // XCB → 메인 스레드 깨우기용

// XCB 이벤트 루프
std::thread xcbThread([&] {
    xcb_generic_event_t* event;
    uint64_t buf;
    while (running) {
        event = xcb_poll_for_event(connection);
        if (event) {
            handleX11Event(event);
            free(event);
        } else {
            // 큐 비었으면 eventfd로 깨어남
            read(eventFd, &buf, sizeof(buf));
        }
    }
});
```

또는 `xcb_wait_for_event`로 **블로킹** + 렌더 스레드와 동기화. 이 경우 큐가 비면 OS가 깨움. 단 **`xcb_wait_for_event`는 다른 스레드에서 호출 불가** (XCB는 thread-safe하지 않음).

**실전 권장**: 단일 스레드 = `xcb_poll_for_event` + 렌더 (가장 안전).

**Vulkan + XCB**: `SendMessage` 같은 cross-thread send 이슈 없음. 펌프는 `xcb_poll_for_event`로 직접.

### 7.3. Wayland

Wayland는 비동기 — 클라이언트가 직접 메시지 큐를 관리. `wl_display_roundtrip`, `wl_display_dispatch` 등으로 처리.

**단일 스레드 + 비블로킹**:

```c
while (running) {
    // wl_display_dispatch_pending: 큐의 모든 메시지 non-blocking 처리
    wl_display_dispatch_pending(display);
    // wl_display_flush: 요청 송신
    wl_display_flush(display);
    RenderFrame();
}
```

**Vulkan + Wayland**: Wayland는 본질적으로 **MAILBOX present mode** (스펙 §37.4 Issue 2 RESOLVED: Yes). `vkAcquireNextImageKHR`에서 deadlock 가능성 낮음 (MAILBOX라 큐 길이 1).

**분리 스레드**: Wayland client 라이브러리(libwayland-client)는 thread-safe하지 않음. **반드시 단일 스레드에서 호출**.

### 7.4. Android (Native Activity)

Android에서 순수 네이티브 Vulkan 앱은 보통 **`android_native_app_glue`** 기반의 **Native Activity**로 시작. Java/Kotlin UI 없이 모든 라이프사이클을 C/C++에서 처리.

**android_native_app_glue 기본 구조**:

```c
// main.c (Native Activity 진입점)
#include <android_native_app_glue.h>

// 전역 앱 상태
struct App {
    ANativeWindow*   window;     // 현재 윈도우
    pthread_t        renderThread;
    bool             running;
    // ... Vulkan instance, device, swapchain 등 ...
};
static struct App app = {};

// 렌더 스레드
static void* renderThreadFn(void* arg) {
    struct App* a = (struct App*)arg;
    while (a->running) {
        // surface 확인
        if (!a->window) { sleep(1); continue; }

        // vkCreateAndroidSurfaceKHR(window) → ... (한 번)
        // acquire → record → submit → present
        // ...
    }
    return nullptr;
}

// ANativeActivityCallbacks (메인 스레드에서 호출됨)
static void onNativeWindowCreated(ANativeActivity* activity, ANativeWindow* window) {
    app.window = window;  // ANativeWindow 보관 (참조만, release 안 함)
    pthread_create(&app.renderThread, nullptr, renderThreadFn, &app);
}

static void onNativeWindowDestroyed(ANativeActivity* activity, ANativeWindow* window) {
    app.running = false;
    pthread_join(app.renderThread, nullptr);  // 렌더 스레드 종료 대기
    app.window = nullptr;  // window release는 Android가 처리
}

static void onPause(ANativeActivity* activity) {
    // Vulkan 명령은 메인 스레드에서 호출 가능 (간단한 명령)
    // 복잡한 작업은 렌더 스레드 정지 + device waitIdle 후 처리
    app.running = false;
    pthread_join(app.renderThread, nullptr);
    vkDeviceWaitIdle(device);
}

static void onResume(ANativeActivity* activity) {
    app.running = true;
    pthread_create(&app.renderThread, nullptr, renderThreadFn, &app);
}

void android_main(struct android_app* app_state) {
    ANativeActivity* activity = app_state->activity;
    ANativeActivity_setCallbacks(activity, &(ANativeActivityCallbacks){
        .onNativeWindowCreated  = onNativeWindowCreated,
        .onNativeWindowDestroyed = onNativeWindowDestroyed,
        .onPause                = onPause,
        .onResume               = onResume,
    });

    // Vulkan instance 생성 (메인 스레드)
    createVulkanInstance();

    // 메시지 펌프 시작 (메인 스레드, 절대 반환 안 함)
    while (1) {
        // 모든 pending 이벤트를 처리
        int events;
        struct android_poll_source* source;
        if (ALooper_pollOnce(0, nullptr, &events, (void**)&source) >= 0) {
            if (source) source->process(app_state, source);
        }
    }
}
```

**스레드 구조**:

| 스레드 | 역할 | OS API |
|--------|------|--------|
| **메인 스레드** (=UI 스레드) | `ANativeActivity` 콜백 처리, `ALooper_pollOnce` 펌프, 렌더 스레드 시작/정지 | `ALooper`, `ANativeActivity_*` |
| **렌더 스레드** | `vkAcquireNextImageKHR`, `vkQueueSubmit`, `vkQueuePresentKHR` 등 | `pthread_create` |
| (선택) **워커 스레드** | 비동기 로딩, asset 처리 | `pthread` |

**핵심 안전성**:

- **모든 physical device / queue family가 모든 native window에 대해 present 지원** (스펙 §37.4.1). 별도 `vkGetPhysicalDeviceSurfaceSupportKHR` 쿼리 불필요.
- **swapchain extent 제약 없음** (Win32와 다름). `currentExtent`가 (0, 0)이 아니면 swapchain 생성 가능.
- **`SendMessage` 같은 cross-thread deadlock 없음**. OS 메시지 펌프는 메인 스레드(`ALooper`), Vulkan은 별도 스레드.
- **`ANativeWindow`는 메인 스레드에서만 해제**. 렌더 스레드에서 `ANativeWindow_release` 호출하면 UB. Android NDK가 알아서 release하므로 보통 **release 호출 안 함**.

**ANativeWindow lifecycle** (중요):

| 이벤트 | callback | 해야 할 일 |
|--------|----------|-----------|
| 윈도우 생성됨 | `onNativeWindowCreated` | window 보관, 렌더 스레드 시작 |
| 윈도우 파괴됨 | `onNativeWindowDestroyed` | 렌더 스레드 정지, swapchain destroy, **window = nullptr** |
| 일시정지 | `onPause` | 렌더 스레드 정지 + `vkDeviceWaitIdle` |
| 재개 | `onResume` | 렌더 스레드 다시 시작 |
| 활동 파괴 | `onDestroy` | instance destroy |

**`vkCreateAndroidSurfaceKHR` 흐름**:

```c
// window를 받자마자 surface 생성
VkAndroidSurfaceCreateInfoKHR sci{};
sci.sType  = VK_STRUCTURE_TYPE_ANDROID_SURFACE_CREATE_INFO_KHR;
sci.window = window;  // ANativeWindow* (보유만, release 안 함)

VkSurfaceKHR vkSurface;
vkCreateAndroidSurfaceKHR(instance, &sci, nullptr, &vkSurface);
```

> **스펙 원문 (VUID-VkAndroidSurfaceCreateInfoKHR-window-01248)** `window` must point to a valid Android `ANativeWindow`.

**`ANativeWindow_acquire` / `release`** (고급):

- `ANativeWindow_acquire(window)`: 참조 카운트 증가. ANativeActivity가 자동으로 호출하므로 보통 수동 호출 불필요.
- `ANativeWindow_release(window)`: 참조 카운트 감소. 마찬가지로 보통 자동.

**렌더 스레드에서 surface 사용** (메인 스레드 외):

- `vkAcquireNextImageKHR`, `vkQueuePresentKHR`는 **렌더 스레드에서 호출** 가능. surface 자체는 thread-safe.
- 단 `ANativeWindow`의 native handle은 **메인 스레드에서만 release 가능**. 그래서 `onNativeWindowDestroyed`에서 `app.window = nullptr`로 끊고, 렌더 스레드는 매 프레임 `if (!a->window) { sleep(1); continue; }`로 가드.

**Java UI 스레드와의 통신** (필요 시):

- Java 측 UI 이벤트(터치 등)는 `ALooper`로 메인 스레드에서 처리. 렌더 스레드로 전달하려면 lock-free 큐 또는 atomic flag.
- 보통 `android_app->onInputEvent` 콜백에서 atomic에 입력 누적 → 렌더 스레드가 폴링.

### 7.5. macOS (MoltenVK)

macOS의 메시지 루프는 **NSRunLoop**. `NSApplication` 또는 `dispatchMain`.

**NSApplication 사용 (전통적)**:

```objc
[NSApp run];  // 메인 스레드에서 무한 루프
// NSApp의 delegate가 applicationDidFinishLaunching에서 렌더 시작
```

**단일 스레드 + 수동 펌프** (AppKit 없이, 흔한 패턴):

```objc
while (running) {
    // 다음 이벤트까지 blocking
    NSEvent* event = [NSApp nextEventMatchingMask:NSEventMaskAny
        untilDate:[NSDate distantFuture]
        inMode:NSDefaultRunLoopMode
        dequeue:YES];
    if (event) [NSApp sendEvent:event];
    RenderFrame();
}
```

**Vulkan + MoltenVK 주의**:
- `VK_MVK_macos_surface`는 `NSView*`를 받음. NSView 변경(예: 윈도우 리사이즈) 시 surface 갱신 필요할 수 있음.
- `dispatchMain()`도 가능하지만 blocking이라 렌더 스레드에서 호출 시 메시지 처리 안 됨.
- macOS는 `SendMessage`가 없으므로 Win32 같은 cross-thread deadlock 패턴은 없음. 단, **NSView는 메인 스레드에서만 안전**.

**실전 권장**: 메인 스레드 = `NSApp run` 또는 수동 펌프. 렌더는 메인 스레드 또는 별도 스레드. NSView 접근은 **반드시 메인 스레드**.

### 7.6. iOS (MoltenVK)

iOS는 **UIKit 메인 스레드 강제**. 모든 UI 이벤트는 메인 스레드.

```objc
// AppDelegate.mm
- (BOOL)application:(UIApplication*)application
    didFinishLaunchingWithOptions:(NSDictionary*)launchOptions {
    // 메인 스레드. Vulkan 렌더 스레드 시작.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        runVulkanRenderThread(self.window.rootViewController.view);
    });
    return YES;
}
```

**iOS의 특성**:
- iOS는 **MAILBOX present mode 강제** (VSync 필수). 다른 모드 사용 불가.
- `CAMetalLayer` (MoltenVK가 내부 사용)에 직접 present.
- iOS의 `CADisplayLink`로 vsync 동기화:
  ```objc
  CADisplayLink* displayLink = [CADisplayLink displayLinkWithTarget:self
      selector:@selector(renderFrame:)];
  [displayLink addToRunLoop:[NSRunLoop mainRunLoop]
      forMode:NSRunLoopCommonModes];
  ```
- cross-thread deadlock 패턴 **없음** (Cocoa 메인 스레드 + 작업 스레드 분리). 단 메인 스레드 UIKit은 **반드시 메인 스레드**.

### 7.7. 정리표

| 플랫폼 | 메시지 펌프 함수 | Single-thread 권장 | Cross-thread 안전성 |
|--------|------------------|---------------------|----------------------|
| **Win32** | `GetMessage` / `PeekMessage` / `MsgWaitForMultipleObjects` | ✅ (`PeekMessage` + 렌더) | `SendMessage` deadlock 함정 있음. 펌프가 도는 스레드에서 호출. |
| **X11 (XCB)** | `xcb_poll_for_event` (non-blocking) / `xcb_wait_for_event` (blocking) | ✅ (`xcb_poll_for_event` + 렌더) | XCB는 thread-safe 안 함. 단일 스레드. |
| **Wayland** | `wl_display_dispatch_pending` / `wl_display_roundtrip` | ✅ (반드시 단일 스레드) | libwayland-client는 thread-safe 안 함. |
| **Android** | Java `Looper.loop` (UI 스레드) | ❌ (UI는 메인, 렌더는 별도) | ✓ 안전. ANativeWindow만 thread-safe하게 사용. |
| **macOS (MoltenVK)** | `NSApp run` / 수동 `nextEventMatchingMask` | ✅ (`[NSApp nextEventMatchingMask...]` + 렌더) | NSView는 메인 스레드만. `SendMessage` 동등 이슈 없음. |
| **iOS (MoltenVK)** | UIKit main loop / `CADisplayLink` | ✅ (UI는 메인, 렌더는 백그라운드) | ✓ 안전. UIKit은 메인 스레드 강제. |

| 의도 | 권장 |
|------|------|
| Win32 단일 스레드, 작은 프로젝트 | `PeekMessage` + 렌더 |
| Win32 멀티스레드, 성능 중요 | `MsgWaitForMultipleObjects` + 별도 펌프 스레드 |
| X11 | 단일 스레드 + `xcb_poll_for_event` |
| Wayland | 단일 스레드 + `wl_display_dispatch_pending` |
| Android | Java UI 스레드 + C++ 렌더 스레드 분리 |
| macOS / iOS (MoltenVK) | 메인 스레드 NSApp/UIKit + 별도 렌더 스레드 |

---

## 8. Surfaceless context (surface 없이 렌더)

`VK_KHR_surfaceless_context` 또는 `VK_EXT_surface_maintenance1`로 surface 없이 swapchain 생성. 예: **offscreen-only Vulkan 디바이스**, compute-only 작업.

```c
// 1.3+에서 surface_maintenance1가 표준
VkPhysicalDeviceSurfaceMaintenance1FeaturesKHR smf{};
smf.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SURFACE_MAINTENANCE_1_FEATURES_KHR;
smf.surfaceMaintenance1 = VK_TRUE;

VkPhysicalDeviceFeatures2 pdf2{};
pdf2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
pdf2.pNext = &smf;
vkGetPhysicalDeviceFeatures2(physicalDevice, &pdf2);
```

`vkCreateSwapchainKHR`에서 `VkSwapchainCreateInfoKHR::surface = VK_NULL_HANDLE`로 호출 (feature 활성화 시). image는 readback해서 사용.

---

## 9. 빠른 참조 — Win32 / XCB / Wayland / Android 비교

| 단계 | Win32 | XCB | Wayland | Android |
|------|-------|-----|---------|---------|
| OS 핸들 | `HWND` | `xcb_window_t` | `wl_surface` | `ANativeWindow*` |
| OS 연결 | (없음) | `xcb_connection_t*` | `wl_display*` | (없음) |
| Vulkan surface 생성 | `vkCreateWin32SurfaceKHR` | `vkCreateXcbSurfaceKHR` | `vkCreateWaylandSurfaceKHR` | `vkCreateAndroidSurfaceKHR` |
| 메시지 루프 | `GetMessage` / `PeekMessage` | `xcb_wait_for_event` / `xcb_poll_for_event` | `wl_display_roundtrip` / `wl_display_dispatch` | Java UI 스레드 |
| Present 지원 추가 조회 | `vkGetPhysicalDeviceWin32PresentationSupportKHR` | `vkGetPhysicalDeviceXcbPresentationSupportKHR` | `vkGetPhysicalDeviceWaylandPresentationSupportKHR` | (없음) |
| Swapchain extent 제약 | 항상 window size | (유연) | (유연) | (유연) |
| 헤더 | `<windows.h>` | `<xcb/xcb.h>` | `<wayland-client.h>` | `<android/native_window.h>` |

| 의도 | 권장 |
|------|------|
| Windows 데스크톱 | `VK_KHR_win32_surface` |
| Linux (X11) | `VK_KHR_xcb_surface` (또는 xlib) |
| Linux (Wayland) | `VK_KHR_wayland_surface` |
| Android | `VK_KHR_android_surface` |
| macOS (MoltenVK) | `VK_MVK_macos_surface` |
| iOS (MoltenVK) | `VK_MVK_ios_surface` |
| 헤드리스/오프스크린 | `VK_EXT_headless_surface` |
| Surface 없는 렌더 | `VK_KHR_surfaceless_context` 또는 surface_maintenance1 |
| 단일 큐 (가장 단순) | graphics 큐가 present 지원할 때 |
| 별도 present 큐 | present를 다른 큐에 분리 (더 안전) |
