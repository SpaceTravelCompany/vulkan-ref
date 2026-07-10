---
title: 핵심 기반
slug: extensions-foundation
---

## Summary

Vulkan 1.3~1.4 및 Roadmap 2024/2026 기준으로 **현대 렌더링 엔진에 거의 필수적인 확장기능**을 선별했다.
성능 향상, 파이프라인 간소화, 새로운 렌더링 패러다임 위주로 20개를 선정하고,
각각의 활성화 방법과 사용 패턴을 상세히 정리한다.

---

## 선별 기준

1. **Vulkan 1.3/1.4 코어 승격** — 대부분의 최신 GPU가 지원
2. **Roadmap 2024/2026 필수** — 업계 표준으로 인정
3. **성능 직접 향상** — CPU 오버헤드 감소, GPU 효율 개선
4. **새로운 기능 패러다임** — 바인드리스, 메시 셰이딩, 동적 렌더링 등

---

## 1. VK_KHR_dynamic_rendering — 동적 렌더링

> **Vulkan 1.3 코어 승격 | Roadmap 2022 필수**

### 용도

- `VkRenderPass`, `VkFramebuffer` 객체 생성이 **전면 불필요**
- 렌더 타겟을 명령 버퍼 기록 시점에 직접 지정
- 파이프라인 생성이 간소화 (렌더패스 호환성 검사 제거)
- 현대 엔진 (Frostbite, Unreal Engine 5)의 표준 렌더링 방식

### 의존성

- Vulkan 1.0 이상 (독립적)

### 구조체

```c
// 렌더링 정보
typedef struct VkRenderingInfo {
    VkStructureType                     sType;
    const void*                         pNext;
    VkRenderingFlags                    flags;
    VkRect2D                            renderArea;
    uint32_t                            layerCount;
    uint32_t                            viewMask;
    uint32_t                            colorAttachmentCount;
    const VkRenderingAttachmentInfo*    pColorAttachments;
    const VkRenderingAttachmentInfo*    pDepthAttachment;
    const VkRenderingAttachmentInfo*    pStencilAttachment;
} VkRenderingInfo;

// 개별 첨부 정보
typedef struct VkRenderingAttachmentInfo {
    VkStructureType          sType;
    const void*              pNext;
    VkImageView              imageView;
    VkImageLayout            imageLayout;
    VkResolveModeFlagBits    resolveMode;
    VkImageView              resolveImageView;
    VkImageLayout            resolveImageLayout;
    VkAttachmentLoadOp       loadOp;
    VkAttachmentStoreOp      storeOp;
    VkClearValue             clearValue;
} VkRenderingAttachmentInfo;
```

### 사용 방법

```c
// 1. 기능 활성화 (VkDeviceCreateInfo pNext 체인)
VkPhysicalDeviceDynamicRenderingFeatures dynamicRenderingFeatures = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DYNAMIC_RENDERING_FEATURES,
    .dynamicRendering = VK_TRUE,
};

// 2. 파이프라인 생성 시VkPipelineRenderingCreateInfo pipelineRenderingInfo = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO,
    .colorAttachmentCount = 1,
    .pColorAttachmentFormats = &colorFormat,
    .depthAttachmentFormat = depthFormat,
    .stencilAttachmentFormat = VK_FORMAT_UNDEFINED,
};
// → VkGraphicsPipelineCreateInfo::pNext에 연결

// 3. 렌더 패스 시작
VkRenderingAttachmentInfo colorAttachment = {
    .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO,
    .imageView = swapchainImageView,
    .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
    .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
    .storeOp = VK_ATTACHMENT_STORE_OP_STORE,
    .clearValue = (VkClearValue){ .color = {{0.0f, 0.0f, 0.0f, 1.0f}} },
};

VkRenderingInfo renderingInfo = {
    .sType = VK_STRUCTURE_TYPE_RENDERING_INFO,
    .renderArea = { .offset = {0, 0}, .extent = {width, height} },
    .layerCount = 1,
    .colorAttachmentCount = 1,
    .pColorAttachments = &colorAttachment,
};

vkCmdBeginRendering(commandBuffer, &renderingInfo);
// ... 드로우 명령 ...
vkCmdEndRendering(commandBuffer);
```

### 구 RenderPass 대비 장점

| 항목 | RenderPass | Dynamic Rendering |
|------|-----------|-------------------|
| 객체 생성 | `VkRenderPass` + `VkFramebuffer` 필요 | 불필요 |
| 파이프라인 호환성 | Subpass 호환성 검사 필요 | 포맷만 일치하면 됨 |
| 멀티 커맨드버퍼 | Secondary 필요 | Primary에서 직접 분기 가능 |
| 런타임 변경 | 불가 | 매 프레임 변경 가능 |

---

## 2. VK_KHR_synchronization2 — 동기화2

> **Vulkan 1.3 코어 승격 | Roadmap 2022 필수**

### 용도

- **64비트** 파이프라인 스테이지/액세스 마스크 (32비트 한계 돌파)
- 배리어와 이벤트가 **하나의 구조체** (`VkDependencyInfo`)로 통합
- 스테이지 마스크를 배리어 **개별 요소**에 지정 (정밀한 동기화)
- `VK_PIPELINE_STAGE_2_NONE`으로 불필요한 동기 제거
- 레이 트레이싱, 메시 셰이더 등 새 스테이지 지원

### 의존성

- Vulkan 1.0 이상

### 핵심 구조체

```c
typedef struct VkDependencyInfo {
    VkStructureType                  sType;
    const void*                      pNext;
    VkDependencyFlags                dependencyFlags;
    uint32_t                         memoryBarrierCount;
    const VkMemoryBarrier2*          pMemoryBarriers;
    uint32_t                         bufferMemoryBarrierCount;
    const VkBufferMemoryBarrier2*    pBufferMemoryBarriers;
    uint32_t                         imageMemoryBarrierCount;
    const VkImageMemoryBarrier2*     pImageMemoryBarriers;
} VkDependencyInfo;

typedef struct VkMemoryBarrier2 {
    VkStructureType           sType;
    const void*               pNext;
    VkPipelineStageFlags2     srcStageMask;     // 64비트!
    VkAccessFlags2            srcAccessMask;    // 64비트!
    VkPipelineStageFlags2     dstStageMask;     // 64비트!
    VkAccessFlags2            dstAccessMask;    // 64비트!
} VkMemoryBarrier2;

typedef struct VkImageMemoryBarrier2 {
    VkStructureType            sType;
    const void*                pNext;
    VkPipelineStageFlags2      srcStageMask;
    VkAccessFlags2             srcAccessMask;
    VkPipelineStageFlags2      dstStageMask;
    VkAccessFlags2             dstAccessMask;
    VkImageLayout              oldLayout;
    VkImageLayout              newLayout;
    uint32_t                   srcQueueFamilyIndex;
    uint32_t                   dstQueueFamilyIndex;
    VkImage                    image;
    VkImageSubresourceRange    subresourceRange;
} VkImageMemoryBarrier2;
```

### 사용 방법

```c
// 이미지 레이아웃 전환 배리어
VkImageMemoryBarrier2 imageBarrier = {
    .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2,
    .srcStageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT,
    .srcAccessMask = VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT,
    .dstStageMask = VK_PIPELINE_STAGE_2_FRAGMENT_SHADER_BIT,
    .dstAccessMask = VK_ACCESS_2_SHADER_SAMPLED_READ_BIT,
    .oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
    .newLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
    .image = myImage,
    .subresourceRange = {
        .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
        .baseMipLevel = 0,
        .levelCount = 1,
        .baseArrayLayer = 0,
        .layerCount = 1,
    },
};

VkDependencyInfo depInfo = {
    .sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO,
    .imageMemoryBarrierCount = 1,
    .pImageMemoryBarriers = &imageBarrier,
};

vkCmdPipelineBarrier2(commandBuffer, &depInfo);
```

### 구 API 대비 장점

| 항목 | vkCmdPipelineBarrier (1.0) | vkCmdPipelineBarrier2 (1.3) |
|------|---------------------------|----------------------------|
| 스테이지 마스크 | 32비트 (전역) | 64비트 (배리어별) |
| 접근 마스크 | 32비트 (전역) | 64비트 (배리어별) |
| 구조체 수 | 3종 (memory/buffer/image) | 1종 (VkDependencyInfo) |
| 새 스테이지 | 미지원 | RT, 메시 셰이더 등 지원 |

---

## 3. VK_EXT_descriptor_indexing — 바인드리스 디스크립터

> **Vulkan 1.2 코어 승격 | 현대 엔진 필수**

### 용도

- **바인드리스 리소스**: 배열 인덱스로 셰이더에서 직접 리소스 접근
- **Update After Bind**: 디스크립터 세트 바인딩 후에도 디스크립터 업데이트 가능
- **Partially Bound**: 일부 슬롯이 비어있어도 사용 가능 (희소 배열)
- **Variable Count**: 가변 크기 디스크립터 배열
- D3D12 Descriptor Heap과 동등한 기능

### 의존성

- `VK_KHR_get_physical_device_properties2` 또는 Vulkan 1.1

### 핵심 기능 플래그

```c
typedef struct VkPhysicalDeviceDescriptorIndexingFeatures {
    // ...
    VkBool32 shaderSampledImageArrayNonUniformIndexing;     // 비균일 인덱싱
    VkBool32 shaderStorageBufferArrayNonUniformIndexing;
    VkBool32 descriptorBindingSampledImageUpdateAfterBind;  // 바인딩 후 업데이트
    VkBool32 descriptorBindingStorageBufferUpdateAfterBind;
    VkBool32 descriptorBindingUpdateUnusedWhilePending;     // 사용 중 업데이트
    VkBool32 descriptorBindingPartiallyBound;               // 부분 바인딩
    VkBool32 descriptorBindingVariableDescriptorCount;      // 가변 크기
    VkBool32 runtimeDescriptorArray;                        // 런타임 배열
} VkPhysicalDeviceDescriptorIndexingFeatures;
```

### 사용 방법

```c
// 1. 디스크립터 세트 레이아웃 생성 (Update After Bind)
VkDescriptorSetLayoutBinding bindings[] = {
    { .binding = 0, .descriptorType = VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE,
      .descriptorCount = 10000,  // 대규모 배열
      .stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT },
};

VkDescriptorBindingFlags bindingFlags[] = {
    VK_DESCRIPTOR_BINDING_UPDATE_AFTER_BIND_BIT |
    VK_DESCRIPTOR_BINDING_PARTIALLY_BOUND_BIT |
    VK_DESCRIPTOR_BINDING_VARIABLE_DESCRIPTOR_COUNT_BIT,
};

VkDescriptorSetLayoutBindingFlagsCreateInfo bindingFlagsInfo = {
    .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_BINDING_FLAGS_CREATE_INFO,
    .bindingCount = 1,
    .pBindingFlags = bindingFlags,
};

VkDescriptorSetLayoutCreateInfo layoutInfo = {
    .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
    .pNext = &bindingFlagsInfo,
    .flags = VK_DESCRIPTOR_SET_LAYOUT_CREATE_UPDATE_AFTER_BIND_POOL_BIT,
    .bindingCount = 1,
    .pBindings = bindings,
};

// 2. 디스크립터 풀 (Update After Bind)
VkDescriptorPoolCreateInfo poolInfo = {
    .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO,
    .flags = VK_DESCRIPTOR_POOL_CREATE_UPDATE_AFTER_BIND_BIT,
    // ...
};

// 3. 셰이더에서 사용 (GLSL)
/*
layout(set = 0, binding = 0) uniform texture2D textures[];

// 비균일 인덱스로 접근
void main() {
    int idx = objectData[drawId].textureIndex;
    color = texture(sampler2D(textures[nonuniformEXT(idx)], linearSampler), uv);
}
*/
```

### 바인드리스 패턴 요약

```
┌─────────────────────────────────────────────────┐
│  Descriptor Set 0 (전역, 프레임당 1회 바인딩)      │
│  ┌───────────────────────────────────────────┐  │
│  │ binding 0: texture2D textures[10000]      │  │
│  │ binding 1: sampler samplers[16]           │  │
│  │ binding 2: StorageBuffer sceneData[]      │  │
│  └───────────────────────────────────────────┘  │
│                                                 │
│  셰이더: textures[objectId] 로 직접 접근         │
│  → draw call 마다 디스크립터 바인딩 불필요        │
└─────────────────────────────────────────────────┘
```

---

## 4. VK_KHR_buffer_device_address — 버퍼 장치 주소

> **Vulkan 1.2 코어 승격 | RT/메시 셰이딩 필수 기반**

### 용도

- 버퍼를 **64비트 GPU 주소**로 접근 (포인터처럼 사용)
- 레이 트레이싱 가속 구조체의 기반
- 메시 셰이더에서 간접 데이터 접근
- D3D12 GPU Virtual Address와 동등
- 디스크립터 없이 버퍼 직접 참조 가능

### 의존성

- `VK_KHR_get_physical_device_properties2` 또는 Vulkan 1.1

### 사용 방법

```c
// 1. 기능 활성화
VkPhysicalDeviceBufferDeviceAddressFeatures bdaFeatures = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_BUFFER_DEVICE_ADDRESS_FEATURES,
    .bufferDeviceAddress = VK_TRUE,
    .bufferDeviceAddressCaptureReplay = VK_FALSE,
};

// 2. 버퍼 생성 시 플래그 설정
VkBufferCreateInfo bufferInfo = {
    .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO,
    .size = bufferSize,
    .usage = VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT
           | VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,
};

// 3. 메모리 할당 시 플래그 설정
VkMemoryAllocateFlagsInfo allocFlags = {
    .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_FLAGS_INFO,
    .flags = VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT,
};

// 4. 주소 조회
VkBufferDeviceAddressInfo addressInfo = {
    .sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO,
    .buffer = myBuffer,
};
VkDeviceAddress address = vkGetBufferDeviceAddress(device, &addressInfo);

// 5. 셰이더에서 사용 (GLSL)
/*
layout(buffer_reference) buffer MyData {
    uint values[];
};

layout(push_constant) uniform PushConstants {
    MyData data;  // 64비트 포인터
} pc;

void main() {
    uint val = pc.data.values[gl_GlobalInvocationID.x];
}
*/
```

---

## 5. VK_KHR_timeline_semaphore — 타임라인 세마포어

> **Vulkan 1.2 코어 승격 | 멀티스레드/프레임 동기화 필수**

### 용도

- **이진 세마포어**의 한계 돌파: uint64 카운터 기반
- CPU에서 직접 signal/wait 가능 (호스트 동기화)
- **프레임 번호**를 세마포어 값으로 사용 가능
- GPU 간, CPU-GPU 간 복잡한 동기화를 단순화
- 파이프라인 렌더링 (CPU가 N프레임 앞서 작업) 패턴에 필수

### 의존성

- `VK_KHR_get_physical_device_properties2` 또는 Vulkan 1.1

### 사용 방법

```c
// 1. 타임라인 세마포어 생성
VkSemaphoreTypeCreateInfo typeInfo = {
    .sType = VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO,
    .semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE,
    .initialValue = 0,
};

VkSemaphoreCreateInfo semInfo = {
    .sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO,
    .pNext = &typeInfo,
};
VkSemaphore timelineSemaphore;
vkCreateSemaphore(device, &semInfo, NULL, &timelineSemaphore);

// 2. 큐 제출 시 타임라인 값 지정
VkTimelineSemaphoreSubmitInfo timelineInfo = {
    .sType = VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO,
    .waitSemaphoreValueCount = 1,
    .pWaitSemaphoreValues = (uint64_t[]){ frameNumber - 1 },  // 이전 프레임 대기
    .signalSemaphoreValueCount = 1,
    .pSignalSemaphoreValues = (uint64_t[]){ frameNumber },     // 현재 프레임 완료
};

VkSubmitInfo submitInfo = {
    .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO,
    .pNext = &timelineInfo,
    .waitSemaphoreCount = 1,
    .pWaitSemaphores = &timelineSemaphore,
    .pWaitDstStageMask = (VkPipelineStageFlags[]){ VK_PIPELINE_STAGE_ALL_COMMANDS_BIT },
    .signalSemaphoreCount = 1,
    .pSignalSemaphores = &timelineSemaphore,
    // ... command buffers ...
};
vkQueueSubmit(queue, 1, &submitInfo, VK_NULL_HANDLE);

// 3. CPU에서 대기 (특정 프레임 완료까지)
VkSemaphoreWaitInfo waitInfo = {
    .sType = VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO,
    .semaphoreCount = 1,
    .pSemaphores = &timelineSemaphore,
    .pValues = (uint64_t[]){ frameNumber },
};
vkWaitSemaphores(device, &waitInfo, UINT64_MAX);

// 4. CPU에서 직접 signal
VkSemaphoreSignalInfo signalInfo = {
    .sType = VK_STRUCTURE_TYPE_SEMAPHORE_SIGNAL_INFO,
    .semaphore = timelineSemaphore,
    .value = someValue,
};
vkSignalSemaphore(device, &signalInfo);
```

---

## 6. VK_KHR_push_descriptor — 푸시 디스크립터

> **Vulkan 1.4 코어 승격 | Roadmap 2024 필수**

### 용도

- 디스크립터 세트 **할당/바인딩 없이** 직접 푸시
- `vkCmdPushDescriptorSetKHR` 한 번으로 완료
- 작은 유니폼 버퍼, 상수 데이터에 최적
- CPU 오버헤드 대폭 감소

### 의존성

- `VK_KHR_get_physical_device_properties2` 또는 Vulkan 1.1
- `VK_KHR_push_descriptor`는 독립적 (1.0 기반)

### 사용 방법

```c
// 1. 푸시 디스크립터 레이아웃 생성
VkDescriptorSetLayoutCreateInfo layoutInfo = {
    .sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO,
    .flags = VK_DESCRIPTOR_SET_LAYOUT_CREATE_PUSH_DESCRIPTOR_BIT_KHR,
    .bindingCount = 1,
    .pBindings = (VkDescriptorSetLayoutBinding[]){
        { .binding = 0, .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER,
          .descriptorCount = 1, .stageFlags = VK_SHADER_STAGE_ALL },
    },
};

// 2. 명령 버퍼에서 직접 푸시
VkWriteDescriptorSet write = {
    .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
    .dstBinding = 0,
    .descriptorCount = 1,
    .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER,
    .pBufferInfo = &bufferInfo,
};

vkCmdPushDescriptorSetKHR(
    commandBuffer,
    VK_PIPELINE_BIND_POINT_GRAPHICS,
    pipelineLayout,
    0,      // set 번호
    1,      // write 개수
    &write
);
// → vkAllocateDescriptorSets, vkUpdateDescriptorSets, vkCmdBindDescriptorSets 불필요!
```

---

## 종합: 권장 활성화 순서

```
1단계 (기본 필수 — Vulkan 1.3):
  ├── VK_KHR_dynamic_rendering
  ├── VK_KHR_synchronization2
  ├── VK_EXT_descriptor_indexing (1.2)
  ├── VK_KHR_buffer_device_address (1.2)
  ├── VK_KHR_timeline_semaphore (1.2)
  └── VK_EXT_extended_dynamic_state

2단계 (성능 최적화 — Vulkan 1.4 / Roadmap 2024):
  ├── VK_KHR_push_descriptor
  ├── VK_KHR_maintenance5
  ├── VK_KHR_dynamic_rendering_local_read
  ├── VK_KHR_load_store_op_none
  ├── VK_KHR_map_memory2
  ├── VK_KHR_shader_expect_assume
  └── VK_KHR_shader_subgroup_rotate

3단계 (차세대 기능):
  ├── VK_EXT_mesh_shader
  ├── VK_EXT_device_generated_commands
  ├── VK_KHR_fragment_shading_rate
  ├── VK_KHR_acceleration_structure + RT Pipeline + Ray Query
  └── VK_EXT_host_image_copy

4단계 (WSI/디버깅):
  ├── VK_KHR_swapchain_maintenance1
  ├── VK_EXT_pipeline_creation_cache_control
  └── VK_EXT_debug_utils
```
