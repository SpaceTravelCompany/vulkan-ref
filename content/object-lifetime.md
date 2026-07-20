---
title: 객체 수명 & 파괴 순서
slug: object-lifetime
---

## 소개

Vulkan 객체는 **엄격한 생성/파괴 순서**가 있다. **자식을 먼저 파괴하고 부모를 나중에** 파괴해야 하며, GPU가 아직 사용 중인 객체를 파괴하면 UB다.

> **용어 정리**
> - **Child Object**: 다른 객체로부터 생성된 객체. 예: `VkImage`는 `VkDevice`의 자식. `VkSwapchainKHR`는 `VkSurfaceKHR`의 자식.
> - **Pending State**: GPU가 현재 사용 중인 상태. fence/semaphore로 완료 확인 전까지 파괴 불가.
> - **vkDeviceWaitIdle**: 모든 큐가 idle할 때까지 blocking. 안전한 파괴 보장.
> - **VUID-commonparent**: 다른 부모에서 생성된 객체를 같이 사용하면 나는 오류.

이 문서는 **파괴 순서 계층도 → GPU 동기화 → 체크리스트** 흐름을 다룬다.

---

## 1. 파괴 순서 계층도

```
VkInstance
├── VkPhysicalDevice (자동, 별도 파괴 불필요)
├── VkDevice
│   ├── VkFence, VkSemaphore, VkEvent
│   ├── VkCommandPool
│   │   └── VkCommandBuffer
│   ├── VkDescriptorPool → VkDescriptorSetLayout ← VkPipelineLayout ← VkPipeline
│   │   └── VkDescriptorSet                             ↑
│   ├── VkBuffer ← VkDeviceMemory (binding)
│   ├── VkImage ← VkDeviceMemory (binding)
│   │   └── VkImageView
│   ├── VkSampler
│   ├── VkQueryPool
│   ├── VkFramebuffer ← VkRenderPass
│   ├── VkPipelineCache
│   ├── VkShaderModule
│   └── VkSwapchainKHR
│       └── VkImage (presentable, 자동)
├── VkSurfaceKHR
│   └── VkSwapchainKHR ← 여기
│       └── VkImageViews (사용자가 만든 것)
└── VkDebugUtilsMessengerEXT (instance와 동시에 destroy 가능)
```

**화살표(←) 방향이 파괴 순서**: Pipeline → PipelineLayout → DescriptorSetLayout → DescriptorPool → Device.

> **스펙 원문 (VUID-vkDestroyDevice-device-05137)** "All child objects created on device that can be destroyed or freed must have been destroyed or freed prior to destroying device."
>> **Device보다 먼저 모든 device child 파괴**. 단 하나라도 살아있으면 VUID 위반.

> **스펙 원문 (VUID-vkDestroyInstance-instance-00629)** "All child objects that were created with instance or with a VkPhysicalDevice retrieved from it, and that can be destroyed or freed, must have been destroyed or freed prior to destroying instance."
>> **Instance보다 먼저** Surface, VkDevice, DebugUtilsMessenger 등 instance child 모두 파괴.

> **스펙 원문 (VUID-vkDestroySurfaceKHR-surface-01266)** "All VkSwapchainKHR objects created for surface must have been destroyed prior to destroying surface."
>> Surface 파괴 전에 **모든 swapchain을 먼저 파괴**.

---

## 2. 파괴 순서

**생성한 순서의 반대**로 파괴한다. 가장 마지막에 만든 자식부터, 부모로 올라간다.

### 2.1. Swapchain → Surface → Device → Instance

```c
void cleanup() {
    vkDeviceWaitIdle(device);  // 모든 GPU 작업 완료 대기

    // 1. swapchain image views (사용자가 만든 것)
    for (auto& view : swapchainImageViews)
        vkDestroyImageView(device, view, nullptr);

    // 2. swapchain
    vkDestroySwapchainKHR(device, swapchain, nullptr);

    // 3. surface
    vkDestroySurfaceKHR(instance, surface, nullptr);

    // 4. device (자식들은 이미 파괴되었다고 가정)
    vkDestroyDevice(device, nullptr);

    // 5. instance
    vkDestroyInstance(instance, nullptr);
}
```

### 2.2. Pipeline 의존성 체인

```c
// Pipeline → PipelineLayout → DescriptorSetLayout → DescriptorPool 순서
vkDestroyPipeline(device, pipeline, nullptr);
vkDestroyPipelineLayout(device, pipelineLayout, nullptr);
vkDestroyDescriptorSetLayout(device, descriptorSetLayout, nullptr);
vkDestroyDescriptorPool(device, descriptorPool, nullptr);
```

### 2.3. Buffer/Image + Memory

```c
// buffer/image가 device memory에 바인딩되어 있으면
// buffer/image를 먼저 파괴한 후 memory 해제 (또는 동시)
vkDestroyBuffer(device, buffer, nullptr);
vkFreeMemory(device, memory, nullptr);

// 또는 memory 해제 전에 buffer/image를 unbind해도 됨
// 하지만 bind된 리소스가 있으면 memory 해제 불가 (spec valid usage)
```

### 2.4. Command Pool + Buffer

```c
// 보통 pool 파괴만으로 버퍼 자동 정리되지만,
// 명시적이려면:
vkFreeCommandBuffers(device, commandPool, 1, &cmd);
vkDestroyCommandPool(device, commandPool, nullptr);
```

### 2.5. Semaphore / Fence / Event

```c
// GPU가 signal/wait 완료한 후 파괴
vkWaitForFences(device, 1, &fence, VK_TRUE, UINT64_MAX);
vkDestroyFence(device, fence, nullptr);
vkDestroySemaphore(device, semaphore, nullptr);
vkDestroyEvent(device, event, nullptr);
```

---

## 3. `vkDeviceWaitIdle` — 안전망

```c
vkDeviceWaitIdle(device);  // 모든 큐의 모든 작업 완료까지 blocking
```

- **비용이 있음**: 모든 큐 정지. 멀티 스레드 렌더링에서는 페널티.
- **마지막 순간에만**: 보통 앱 종료 시 cleanup 직전 단 한 번.
- **대안**: 각 큐를 `vkQueueWaitIdle`로 개별 정지. fence + `vkWaitForFences`로 특정 작업만 대기.

> **실전 팁** `vkDeviceWaitIdle`은 **절대 프레임 루프 안에서 호출 금지**. FPS가 1~2로 떨어짐.

---

## 4. 자주 빠지는 주의사항

### 4.1. 파괴 순서

- [ ] **Device보다 먼저** VkImage/VkBuffer/VkPipeline/VkFramebuffer 등 device child 파괴 안 함 → VUID-vkDestroyDevice-device-05137.
- [ ] **Swapchain보다 먼저** swapchain의 image views 파괴 안 함 → swapchain이 참조하는 views가 dangling.
- [ ] **Surface보다 먼저** swapchain 파괴 안 함 → VUID-vkDestroySurfaceKHR-surface-01266.
- [ ] **Pipeline보다 먼저** pipeline layout 파괴 (pipeline이 layout 참조 중).
- [ ] **Pipeline Layout보다 먼저** descriptor set layout 파괴 (layout이 set layout 참조 중).
- [ ] **Graphics pipeline library subset** (`VK_GRAPHICS_PIPELINE_LIBRARY_*_BIT_EXT`로 생성한 라이브러리 파이프라인) 파괴 — 메인 파이프라인이 여전히 참조 중일 때 파괴하면 메인 invalid.
- [ ] **DescriptorSet을 Free하지 않고** DescriptorPool을 Destroy → set이 pool보다 먼저 free되어야 함. `vkFreeDescriptorSets` 후 `vkDestroyDescriptorPool`이 정확한 순서.
- [ ] **VkDeviceMemory보다 먼저** memory에 bind된 buffer/image 파괴 안 함 → memory에 dangling reference.

### 4.2. GPU 동기화

- [ ] **Pending 상태의** 커맨드 버퍼를 free/pool destroy → VUID-vkDestroyCommandPool-commandPool-00041.
- [ ] **Signal/wait 중인 semaphore**를 destroy → GPU가 아직 사용 중.
- [ ] **Wait 중인 fence**를 destroy → CPU가 아직 대기 중.
- [ ] **Pending draw에 사용 중인** VkImage/VkBuffer를 destroy → UB.
- [ ] **Descriptor set을 update한 후 GPU 사용 중에** descriptor pool을 reset/destroy.
- [ ] **Presentation engine이 사용 중인 swapchain image**를 destroy.

### 4.3. Frame loop 안에서의 안전한 재생성

- [ ] `vkDeviceWaitIdle`을 **매 프레임** 호출 → FPS 폭락.
- [ ] Swapchain recreate 시 **이전 swapchain을 파괴**하기 전에 새 swapchain 생성 (oldSwapchain 사용).
- [ ] `vkQueuePresentKHR`가 `VK_ERROR_OUT_OF_DATE_KHR` 반환 → swapchain이 invalid. present 더 호출 불가.
- [ ] `vkDestroySwapchainKHR` 후에도 **아직 present 중인** image의 image view 파괴 → UB. 기다리거나 `oldSwapchain`으로 전가.

### 4.4. Instance / Device 간

- [ ] 다른 VkInstance의 **VkPhysicalDevice**에서 가져온 queue family index로 VkDevice 생성 시도 → VUID-commonparent.
- [ ] Instance A의 surface를 Device B의 swapchain 생성에 사용 → VUID-commonparent.
- [ ] Instance A의 VkPhysicalDevice로 생성한 Device를 Instance B에서 `vkDestroyDevice` → VUID-commonparent.
- [ ] 서로 다른 **VkDevice**의 객체끼리 묶어서 사용 (예: Device A의 buffer를 Device B의 descriptor set에 업데이트) → VUID-commonparent.

### 4.5. 일반

- [ ] `VK_NULL_HANDLE`에 대해 destroy 호출 → 보통 no-op이지만, if guard 없이 반복 호출 시 로그 스팸.
- [ ] `vkDestroy*` 계열 함수는 **호스트 동기화 필요**. 멀티스레드 시 mutex로 보호.
- [ ] `vkFreeDescriptorSets` 없이 `vkDestroyDescriptorPool` → sets 자동 정리되지만, 암시적 정리는 디버깅 힘듦.
- [ ] `vkDestroyPipelineCache` 없이 device destroy → cache 데이터 소실. 의도적이면 save 먼저.

**PipelineCache 저장 패턴**:

```c
size_t size;
vkGetPipelineCacheData(device, cache, &size, nullptr);
std::vector<uint8_t> data(size);
vkGetPipelineCacheData(device, cache, &size, data.data());
// 파일에 쓰기
std::ofstream("pipeline_cache.bin", std::ios::binary).write((char*)data.data(), size);
// 그 후 destroy
vkDestroyPipelineCache(device, cache, nullptr);
```

---

## 5. 전체 종료 패턴

```c
void shutdown() {
    // 0) 모든 GPU 작업 완료
    vkDeviceWaitIdle(device);

    // 1) descriptor sets (free)
    vkFreeDescriptorSets(device, descriptorPool, 1, &descriptorSet);

    // 2) command buffers (free) + pool (destroy)
    vkFreeCommandBuffers(device, commandPool, 1, &cmd);
    vkDestroyCommandPool(device, commandPool, nullptr);

    // 3) pipeline + layout
    vkDestroyPipeline(device, pipeline, nullptr);
    vkDestroyPipelineLayout(device, pipelineLayout, nullptr);

    // 4) descriptor set layout + pool
    vkDestroyDescriptorSetLayout(device, descSetLayout, nullptr);
    vkDestroyDescriptorPool(device, descriptorPool, nullptr);

    // 5) image views
    for (auto& view : textureViews) vkDestroyImageView(device, view, nullptr);

    // 6) images + memory
    for (auto& img : textures) vkDestroyImage(device, img, nullptr);
    for (auto& mem : imageMemories) vkFreeMemory(device, mem, nullptr);

    // 7) buffers + memory
    vkDestroyBuffer(device, vertexBuffer, nullptr);
    vkFreeMemory(device, vertexBufferMemory, nullptr);

    // 8) samplers
    vkDestroySampler(device, sampler, nullptr);

    // 9) framebuffer + render pass
    vkDestroyFramebuffer(device, framebuffer, nullptr);
    vkDestroyRenderPass(device, renderPass, nullptr);

    // 10) sync objects
    vkDestroySemaphore(device, imageAvailableSemaphore, nullptr);
    vkDestroySemaphore(device, renderFinishedSemaphore, nullptr);
    vkDestroyFence(device, inFlightFence, nullptr);

    // 11) swapchain image views
    for (auto& view : swapchainImageViews) vkDestroyImageView(device, view, nullptr);

    // 12) swapchain
    vkDestroySwapchainKHR(device, swapchain, nullptr);

    // 13) surface
    vkDestroySurfaceKHR(instance, surface, nullptr);

    // 14) device
    vkDestroyDevice(device, nullptr);

    // 15) instance
    vkDestroyInstance(instance, nullptr);
}
```

---

## 6. 빠른 참조 — 파괴 순서표

| 객체 | 자식 | 언제 파괴해야 하는가 |
|------|------|---------------------|
| `VkInstance` | (거의 모든 것) | **가장 마지막** |
| `VkDevice` | Buffer, Image, Pipeline, DescriptorSet, CommandBuffer, ... | Instance 직전 |
| `VkSurfaceKHR` | Swapchain | Device 직전, 단 swapchain 먼저 |
| `VkSwapchainKHR` | (presentable image, ImageView) | Surface 직전 |
| `VkPipeline` | PipelineLayout, ShaderModule, RenderPass | device child 중 |
| `VkPipelineLayout` | DescriptorSetLayout, PushConstantRange | Pipeline 직전 |
| `VkDescriptorPool` | DescriptorSet | Set free 후, device child 중 |
| `VkRenderPass` | Framebuffer, GraphicsPipeline | Framebuffer 직전 또는 동시 |
| `VkFramebuffer` | ImageView | RenderPass 직전 또는 동시 |
| `VkImageView` | Image | Image 직전 |
| `VkImage` / `VkBuffer` | DeviceMemory | DeviceMemory 해제 전 |
| `VkDeviceMemory` | (없음) | Buffer/Image 직후 (또는 unbind 후) |
| `VkCommandPool` | CommandBuffer | Buffer free 후 |
| `VkFence` / `VkSemaphore` / `VkEvent` | (없음) | signal/wait 완료 후 |

| 함정 | 대처 |
|------|------|
| GPU 사용 중인 객체 파괴 | `vkDeviceWaitIdle` 또는 fence 확인 |
| Instance 먼저 파괴 | 무조건 Instance를 가장 마지막에 |
| Surfaced보다 swapchain 먼저? | Swapchain → Surface → Device → Instance 순서 |
| Frame loop에서 recreate | `oldSwapchain` 인자로 이전 핸들 넘기기 |
| 멀티스레드 destroy | mutex로 보호, device/instance 외부 동기화 |
