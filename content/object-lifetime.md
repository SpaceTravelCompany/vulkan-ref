---
title: 객체 수명 & 파괴 순서
slug: object-lifetime
---

## 소개

Vulkan 객체는 **엄격한 생성 및 파괴 순서 규칙**을 따른다. 기본 원칙은 **자식 객체를 먼저 파괴하고 부모 객체를 나중에 파괴**하는 것이며, GPU가 아직 실행 중인 커맨드에서 참조하는 객체를 파괴하면 미정의 동작(Undefined Behavior)을 유발한다.

> **용어 정리**
> - **자식 객체(Child Object)**: 다른 상위 객체로부터 생성된 하위 객체. 예: `VkImage`는 `VkDevice`의 자식 객체이며, `VkSwapchainKHR`는 `VkSurfaceKHR`와 `VkDevice`에 종속된다.
> - **대기 상태(Pending State)**: GPU가 해당 리소스를 읽거나 쓰는 중인 상태. 펜스나 세마포어로 실행 완료를 확인하기 전에는 파괴할 수 없다.
> - **`vkDeviceWaitIdle`**: 디바이스의 모든 큐가 유휴(Idle) 상태가 될 때까지 CPU 스레드를 차단(Blocking)한다. 안전한 전면 정리를 보장하지만 호출 비용이 크다.
> - **VUID-commonparent**: 서로 다른 부모 객체로부터 파생된 자식 객체들을 잘못 조합하여 사용할 때 발생하는 유효성 검증 오류.

파괴 순서 계층도, GPU 동기화 원칙, 종료 루틴, 점검 항목을 정리한다.

---

## 1. 파괴 순서 계층도

Vulkan 객체는 상위 객체 및 참조 대상 객체와의 의존성에 따라 올바른 순서로 파괴해야 한다.

```
VkInstance
├── VkPhysicalDevice (물리 디바이스 — 구현체 관리, 별도 파괴 불필요)
├── VkDevice
│   ├── VkFence, VkSemaphore, VkEvent (동기화 프리미티브)
│   ├── VkCommandPool (커맨드 풀 파괴 시 할당된 VkCommandBuffer 자동 해제)
│   │   └── VkCommandBuffer
│   ├── VkDescriptorPool (풀 파괴 시 할당된 VkDescriptorSet 자동 해제)
│   │   └── VkDescriptorSet
│   ├── VkDescriptorSetLayout (참조 커맨드 완료 후 파괴)
│   ├── VkPipelineLayout (참조 커맨드 완료 후 파괴; 1.3/maintenance4에서는 파이프라인 생성 직후 파괴 가능)
│   ├── VkPipeline (렌더 패스보다 먼저 파괴)
│   ├── VkFramebuffer (RenderPass보다 먼저 파괴)
│   ├── VkRenderPass (Framebuffer 및 사용 파이프라인 파괴 후 파괴)
│   ├── VkImageView (Image보다 먼저 파괴)
│   ├── VkImage / VkBuffer (바인딩된 VkDeviceMemory 해제 전 파괴)
│   │   └── 바인딩 대상: VkDeviceMemory
│   ├── VkSampler
│   ├── VkQueryPool
│   ├── VkPipelineCache
│   ├── VkShaderModule
│   └── VkSwapchainKHR (Surface 파괴 전 파괴)
│       └── 스왑체인 이미지 (스왑체인 소멸 시 자동 해제)
├── VkSurfaceKHR (Swapchain 파괴 후 파괴)
└── VkDebugUtilsMessengerEXT (인스턴스 자식 객체이므로 인스턴스 파괴 전에 명시적 파괴 필요; VUID-vkDestroyInstance-instance-00629)
```

**핵심 의존성 및 파괴 순서 원칙 (참조 객체 먼저 파괴):**

1. **파이프라인 체인**: `VkPipeline` 파괴 → `VkPipelineLayout`/`VkDescriptorSetLayout` 파괴 (권장 순서이나 스펙 필수 아님; 1.3/maintenance4에서는 파이프라인 생성 직후 레이아웃 파괴 가능)
2. **렌더 패스 체인**: `VkFramebuffer` 및 사용 `VkPipeline` 파괴 → `VkRenderPass` 파괴
3. **디스크립터 체인**: GPU 작업 완료 → (선택적 개별 해제) → `VkDescriptorPool` 파괴 (소속 디스크립터 세트 자동 해제)
4. **이미지 체인**: `VkImageView` 파괴 → `VkImage` 파괴 → 바인딩된 `VkDeviceMemory` 해제
5. **버퍼 체인**: `VkBuffer` 파괴 → 바인딩된 `VkDeviceMemory` 해제
6. **프레젠테이션 체인**: 스왑체인 `VkImageView` 파괴 → `VkSwapchainKHR` 파괴 → `VkSurfaceKHR` 파괴
7. **디바이스 체인**: 모든 디바이스 레벨 자식 객체 파괴 → `VkDevice` 파괴
8. **인스턴스 체인**: 모든 인스턴스 레벨 자식 객체(Device, Surface, Debug Messenger) 파괴 → `VkInstance` 파괴

> **스펙 원문 (VUID-vkDestroyDevice-device-05137)**
> "All child objects created on device that can be destroyed or freed must have been destroyed or freed prior to destroying device."
> 디바이스를 파괴하기 전에 해당 디바이스에서 생성된 모든 자식 객체를 먼저 파괴하거나 해제해야 한다.

> **스펙 원문 (VUID-vkDestroyInstance-instance-00629)**
> "All child objects that were created with instance or with a VkPhysicalDevice retrieved from it, and that can be destroyed or freed, must have been destroyed or freed prior to destroying instance."
> 인스턴스를 파괴하기 전에 해당 인스턴스 또는 물리 디바이스로부터 생성된 모든 자식 객체(`VkSurfaceKHR`, `VkDevice`, `VkDebugUtilsMessengerEXT` 등)를 먼저 파괴해야 한다.

> **스펙 원문 (VUID-vkDestroySurfaceKHR-surface-01266)**
> "All VkSwapchainKHR objects created for surface must have been destroyed prior to destroying surface."
> 서피스를 파괴하기 전에 해당 서피스를 대상으로 생성된 모든 스왑체인을 먼저 파괴해야 한다.

---

## 2. 주요 서브시스템별 파괴 절차

항상 **생성의 역순**으로 파괴하는 것이 기본 규칙이다.

### 2.1. Swapchain → Surface → Device → Instance

```c
void cleanupSwapchainAndDevice() {
    vkDeviceWaitIdle(device);  // 모든 GPU 큐의 작업 완료 대기

    // 1. 스왑체인 이미지 뷰 (애플리케이션이 생성한 뷰)
    for (auto& view : swapchainImageViews) {
        vkDestroyImageView(device, view, nullptr);
    }
    swapchainImageViews.clear();

    // 2. 스왑체인 파괴
    vkDestroySwapchainKHR(device, swapchain, nullptr);

    // 3. 서피스 파괴 (반드시 스왑체인이 먼저 파괴되어야 함)
    vkDestroySurfaceKHR(instance, surface, nullptr);

    // 4. 논리 디바이스 파괴 (디바이스 소속 모든 리소스가 이미 파괴된 상태여야 함)
    vkDestroyDevice(device, nullptr);

    // 5. 인스턴스 파괴
    vkDestroyInstance(instance, nullptr);
}
```

### 2.2. Pipeline 및 Descriptor 레이아웃 체인

```c
// 1. 파이프라인 파괴 (레이아웃을 참조하므로 레이아웃보다 먼저 파괴)
vkDestroyPipeline(device, pipeline, nullptr);

// 2. 파이프라인 레이아웃 파괴 (디스크립터 세트 레이아웃보다 먼저 파괴)
vkDestroyPipelineLayout(device, pipelineLayout, nullptr);

// 3. 디스크립터 세트 레이아웃 파괴
vkDestroyDescriptorSetLayout(device, descriptorSetLayout, nullptr);

// 4. 디스크립터 풀 파괴 (풀 파괴 시 소속된 모든 디스크립터 세트는 자동으로 일괄 정리됨)
vkDestroyDescriptorPool(device, descriptorPool, nullptr);
```

### 2.3. Buffer / Image와 Device Memory

```c
// 버퍼나 이미지가 VkDeviceMemory에 바인딩되어 있는 경우,
// 버퍼/이미지를 먼저 파괴한 뒤 해당 메모리를 해제한다.
vkDestroyBuffer(device, vertexBuffer, nullptr);
vkFreeMemory(device, vertexBufferMemory, nullptr);

vkDestroyImageView(device, textureImageView, nullptr);
vkDestroyImage(device, textureImage, nullptr);
vkFreeMemory(device, textureImageMemory, nullptr);
```

### 2.4. Command Pool과 Command Buffer

```c
// 커맨드 풀 파괴 시 풀에서 할당된 모든 커맨드 버퍼가 자동으로 일괄 해제된다.
// 명시적으로 개별 해제하려면 다음을 호출할 수 있다.
vkFreeCommandBuffers(device, commandPool, 1, &cmdBuffer);

// 커맨드 풀 파괴
vkDestroyCommandPool(device, commandPool, nullptr);
```

### 2.5. 동기화 객체 (Fence, Semaphore, Event)

```c
// GPU가 신호를 보내거나 대기 중인 상태가 완전히 종료된 후 파괴해야 한다.
vkWaitForFences(device, 1, &inFlightFence, VK_TRUE, UINT64_MAX);
vkDestroyFence(device, inFlightFence, nullptr);
vkDestroySemaphore(device, renderFinishedSemaphore, nullptr);
vkDestroySemaphore(device, imageAvailableSemaphore, nullptr);
```

---

## 3. `vkDeviceWaitIdle` — 안전망 활용

```c
vkDeviceWaitIdle(device);  // 디바이스 내 모든 큐의 모든 작업 완료 시까지 블로킹
```

- **동작 특성**: 모든 큐의 파이프라인을 완전히 비우므로 안전한 리소스 파괴가 보장된다.
- **호출 시점**: 애플리케이션 종료 루틴 진입 시 1회 호출하거나 창 크기 변경에 따른 스왑체인 재생성 직전에 사용한다.
- **성능 주의**: `vkDeviceWaitIdle`을 렌더링 루프 내부에서 매 프레임 호출하면 CPU와 GPU의 병렬 실행이 무력화되어 심각한 프레임 저하가 발생한다. 프레임 간 동기화에는 반드시 `VkFence`와 `VkSemaphore`를 활용해야 한다.

---

## 4. 자주 발생하는 실수 및 점검 항목

### 4.1. 파괴 순서 위반

- [ ] **디바이스 소멸 전 자식 미정리**: `VkImage`, `VkBuffer`, `VkPipeline`, `VkFramebuffer` 등의 자식 객체를 정리하지 않고 `vkDestroyDevice` 호출 (VUID-vkDestroyDevice-device-05137 위반).
- [ ] **스왑체인 파괴 전 이미지 뷰 미정리**: 스왑체인 이미지를 가리키는 `VkImageView`를 스왑체인보다 나중에 파괴하는 경우.
- [ ] **서피스 파괴 전 스왑체인 미정리**: `VkSwapchainKHR`를 소멸시키지 않고 `vkDestroySurfaceKHR` 호출 (VUID-vkDestroySurfaceKHR-surface-01266 위반).
- [ ] **커맨드 기록/실행 중 레이아웃 파괴**: 해당 레이아웃을 사용하는 커맨드 버퍼가 recording/pending 상태인 동안 `vkDestroyPipelineLayout` 또는 `vkDestroyDescriptorSetLayout` 호출. (단, 1.3/maintenance4에서는 파이프라인 생성 커맨드가 끝난 직후 레이아웃 파괴가 합법이다.)
- [ ] **렌더 패스 파괴 전 프레임버퍼 미정리**: `VkFramebuffer`가 `VkRenderPass`를 참조하므로 반드시 프레임버퍼를 먼저 파괴해야 함.
- [ ] **DescriptorSet 개별 해제와 DescriptorPool 파괴**:
  - `VkDescriptorSet`은 스펙상 `VkDescriptorPool` 파괴 시 암묵적으로 자동 해제되므로 `vkFreeDescriptorSets` 호출이 필수가 아니다.
  - 풀 생성 시 `VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT` 플래그를 설정한 경우에만 `vkFreeDescriptorSets`를 통한 개별 해제가 허용된다. 플래그가 없는 풀에서 `vkFreeDescriptorSets`를 호출하면 유효성 검증 오류가 발생한다.
- [ ] **메모리 해제 전 리소스 미정리**: 메모리에 바인딩된 버퍼나 이미지를 파괴하지 않고 `vkFreeMemory` 호출.

### 4.2. GPU 실행 중 리소스 파괴 (동기화 누락)

- [ ] **실행 대기(Pending) 상태의 커맨드 버퍼 정리**: GPU가 큐에서 소비 중인 커맨드 버퍼를 해제하거나 해당 커맨드 풀을 파괴하는 경우 (VUID-vkDestroyCommandPool-commandPool-00041 위반).
- [ ] **시그널/대기 중인 세마포어 소멸**: 큐 작업에서 대기 또는 신호 예약 중인 세마포어를 파괴하는 경우.
- [ ] **대기 중인 펜스 소멸**: CPU 또는 GPU가 상태 변경을 대기 중인 펜스를 파괴하는 경우.
- [ ] **드로우 실행 중인 버퍼/이미지 소멸**: GPU가 렌더링 중인 정점 버퍼나 텍스처를 파괴하여 미정의 동작(Undefined Behavior)을 유발하는 경우.
- [ ] **디스크립터 세트 갱신 중 풀 리셋**: GPU가 셰이더에서 읽는 중인 디스크립터 세트가 속한 풀을 리셋하거나 파괴하는 경우.
- [ ] **화면 표시(Presentation) 중인 스왑체인 이미지 뷰 소멸**: 프레젠테이션 엔진이 읽고 있는 이미지의 뷰를 파괴하여 화면 깨짐 또는 크래시를 유발하는 경우.

> [!TIP]
> GPU 작업 완료 대기는 `vkDeviceWaitIdle`(전체 디바이스 블로킹)보다 **프레임별 펜스** 또는 `vkQueueWaitIdle`(단일 큐 대기)을 사용하는 것이 성능에 유리하다. `vkDeviceWaitIdle`은 매 프레임 호출하면 파이프라인 버블을 유발하므로 전면 종료 시점에만 사용한다.

### 4.3. 렌더링 루프 내부의 리소스 재생성

- [ ] 매 프레임 `vkDeviceWaitIdle`을 호출하여 파이프라인 버블을 유발하는 경우.
- [ ] 스왑체인 재생성(Recreation) 시 새 스왑체인의 `oldSwapchain` 필드에 기존 스왑체인 핸들을 전달하지 않고 즉시 파괴하는 경우.
- [ ] `vkQueuePresentKHR`가 `VK_ERROR_OUT_OF_DATE_KHR`를 반환했음에도 무효화된 스왑체인에 대해 드로우 및 표시 명령을 지속하는 경우.
- [ ] 프레젠테이션 엔진에서 사용 중인 이미지의 뷰를 즉시 파괴하여 미정의 동작(Undefined Behavior)을 유발하는 경우 (펜스로 동기화하거나 이전 스왑체인과 함께 유예 후 정리).

### 4.4. 인스턴스 및 디바이스 간 격리 오류

- [ ] 인스턴스 A의 물리 디바이스 정보를 바탕으로 인스턴스 B의 디바이스를 생성하려 시도하는 경우 (VUID-commonparent 위반).
- [ ] 서로 다른 `VkDevice`에서 생성된 객체들을 단일 디스크립터 세트나 커맨드에 조합하여 사용하는 경우 (VUID-commonparent 위반).

### 4.5. 일반 관리

- [ ] `VK_NULL_HANDLE`에 대해 소멸 함수를 호출하는 경우 (규격상 no-op으로 안전하지만 무분별한 호출은 코드 가독성을 저해함).
- [ ] 멀티스레드 환경에서 동일한 디바이스 객체에 대해 외부 동기화(호스트 뮤텍스) 없이 동시에 파괴 함수를 호출하는 경우.
- [ ] 파이프라인 캐시 데이터를 파일로 저장하지 않고 디바이스를 소멸시켜 재컴파일 최적화 데이터를 유실하는 경우.

---

## 5. 전면 종료 루틴 표준 예제

```c
void shutdownEngine() {
    // 0) 디바이스의 모든 큐 작업이 완료될 때까지 대기
    vkDeviceWaitIdle(device);

    // 1) 디스크립터 풀 파괴
    // 풀 생성 시 VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT가 지정된 경우에만
    // vkFreeDescriptorSets를 통한 개별 해제가 가능하다.
    // 해당 플래그가 없더라도 풀을 파괴하면 소속 디스크립터 세트는 자동으로 일괄 정리된다.
    vkDestroyDescriptorPool(device, descriptorPool, nullptr);

    // 2) 커맨드 버퍼 및 풀 파괴 (풀 파괴 시 할당된 커맨드 버퍼 자동 해제)
    vkDestroyCommandPool(device, commandPool, nullptr);

    // 3) 파이프라인 및 레이아웃 파괴 (파이프라인 먼저 파괴)
    vkDestroyPipeline(device, graphicsPipeline, nullptr);
    vkDestroyPipelineLayout(device, pipelineLayout, nullptr);

    // 4) 디스크립터 세트 레이아웃 파괴
    vkDestroyDescriptorSetLayout(device, descSetLayout, nullptr);

    // 5) 프레임버퍼 및 렌더 패스 파괴 (프레임버퍼가 렌더 패스를 참조하므로 먼저 파괴)
    vkDestroyFramebuffer(device, framebuffer, nullptr);
    vkDestroyRenderPass(device, renderPass, nullptr);

    // 6) 텍스처 및 리소스 뷰 파괴
    vkDestroyImageView(device, textureImageView, nullptr);
    vkDestroyImage(device, textureImage, nullptr);
    vkFreeMemory(device, textureImageMemory, nullptr);

    // 7) 버퍼 및 메모리 해제
    vkDestroyBuffer(device, vertexBuffer, nullptr);
    vkFreeMemory(device, vertexBufferMemory, nullptr);

    // 8) 샘플러 파괴
    vkDestroySampler(device, textureSampler, nullptr);

    // 9) 동기화 프리미티브 파괴
    vkDestroySemaphore(device, imageAvailableSemaphore, nullptr);
    vkDestroySemaphore(device, renderFinishedSemaphore, nullptr);
    vkDestroyFence(device, inFlightFence, nullptr);

    // 10) 스왑체인 이미지 뷰 및 스왑체인 파괴
    for (auto& view : swapchainImageViews) {
        vkDestroyImageView(device, view, nullptr);
    }
    swapchainImageViews.clear();
    vkDestroySwapchainKHR(device, swapchain, nullptr);

    // 11) 서피스 파괴 (스왑체인 파괴 완료 후)
    vkDestroySurfaceKHR(instance, surface, nullptr);

    // 12) 논리 디바이스 파괴 (모든 디바이스 자식 객체 소멸 완료 후)
    vkDestroyDevice(device, nullptr);

    // 13) 디버그 메신저 파괴
    if (debugMessenger != VK_NULL_HANDLE) {
        auto pfnDestroy = (PFN_vkDestroyDebugUtilsMessengerEXT)
            vkGetInstanceProcAddr(instance, "vkDestroyDebugUtilsMessengerEXT");
        if (pfnDestroy) {
            pfnDestroy(instance, debugMessenger, nullptr);
        }
    }

    // 14) 인스턴스 파괴 (가장 마지막 단계)
    vkDestroyInstance(instance, nullptr);
}
```

---

## 6. 빠른 참조 — 객체별 파괴 기준표

| 객체 타입 | 참조/소유 관계 | 파괴 허용 시점 |
|-----------|--------------|---------------|
| `VkInstance` | 루트 객체 | 모든 자식 객체(Device, Surface, Debug Messenger 등) 파괴 후 **가장 마지막** |
| `VkDevice` | 디바이스 자식 객체들의 상위 | 모든 디바이스 소속 객체 파괴 후, `VkInstance` 파괴 직전 |
| `VkSurfaceKHR` | 스왑체인의 대상 표면 | 참조하는 모든 `VkSwapchainKHR` 파괴 후, `VkInstance` 파괴 전 |
| `VkSwapchainKHR` | 프레젠테이션 스왑체인 | 스왑체인용 `VkImageView` 파괴 후, `VkSurfaceKHR` 파괴 전 |
| `VkPipeline` | 그래픽스/컴퓨트 파이프라인 | 커맨드 버퍼의 GPU 실행 완료 후, `VkPipelineLayout` 및 `VkRenderPass` 파괴 전 |
| `VkPipelineLayout` | 디스크립터 및 푸시 상수 레이아웃 | 이를 참조하는 모든 `VkPipeline` 파괴 후, `VkDescriptorSetLayout` 파괴 전 |
| `VkDescriptorSetLayout` | 셰이더 바인딩 명세 | 이를 참조하는 모든 `VkPipelineLayout` 파괴 후 |
| `VkDescriptorPool` | 디스크립터 세트 메모리 풀 | GPU 사용 완료 후 파괴 (풀 파괴 시 소속 세트는 자동 해제되며, 개별 해제는 `FREE_DESCRIPTOR_SET_BIT` 설정 시에만 가능) |
| `VkFramebuffer` | 렌더 패스 어태치먼트 바인딩 | GPU 렌더링 완료 후, **`VkRenderPass` 파괴 전** |
| `VkRenderPass` | 렌더링 서브패스 구조 정의 | 이를 참조하는 모든 `VkFramebuffer` 및 파이프라인(`VkPipeline`) 파괴 후 |
| `VkImageView` | 이미지 서브리소스 뷰 | 이를 바인딩한 디스크립터 세트 및 프레임버퍼 파괴 후, 원본 `VkImage` 파괴 전 |
| `VkImage` / `VkBuffer` | 데이터 리소스 본체 | 바인딩된 메모리(`VkDeviceMemory`) 해제 전 |
| `VkDeviceMemory` | GPU 디바이스 메모리 할당 블록 | 바인딩된 모든 `VkBuffer` 및 `VkImage` 파괴 후 해제 |
| `VkCommandPool` | 커맨드 버퍼 메모리 풀 | 할당된 커맨드 버퍼의 GPU 실행 완료 후 파괴 (풀 파괴 시 커맨드 버퍼 자동 정리) |
| `VkFence` / `VkSemaphore` | CPU/GPU 동기화 기본 요소 | 모든 대기 및 시그널 상태가 해제된 후 |

| 주요 함정 | 올바른 대응 방안 |
|----------|-----------------|
| GPU 실행 중인 객체 파괴 | `vkDeviceWaitIdle` 또는 펜스 완료 대기 후 파괴 |
| 인스턴스를 디바이스보다 먼저 파괴 | 모든 디바이스와 서피스를 정리한 뒤 인스턴스를 가장 마지막에 파괴 |
| Surface보다 Swapchain을 나중에 파괴 | 반드시 Swapchain → Surface 순서로 파괴 |
| RenderPass를 Framebuffer보다 먼저 파괴 | 반드시 Framebuffer → RenderPass 순서로 파괴 |
| PipelineLayout을 Pipeline보다 먼저 파괴 | 권장: Pipeline → PipelineLayout 순서 (단, 1.3/maintenance4에서는 파이프라인 생성 직후 레이아웃 파괴가 합법) |
| 프레임 루프 내부의 스왑체인 재생성 | 새 스왑체인 생성 시 `oldSwapchain`에 이전 핸들을 넘기고 완료 후 이전 객체 파괴 |
| 멀티스레드 동시 파괴 호출 | 호스트 뮤텍스 또는 전담 정리 스레드를 통한 외부 동기화 적용 |
