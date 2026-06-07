---
title: Dynamic Rendering
slug: dynamic-rendering
---

## 소개

Dynamic Rendering은 `VkRenderPass`와 `VkFramebuffer` 객체를 미리 만들지 않고, command buffer 기록 시점에 `vkCmdBeginRendering`으로 렌더 타겟을 직접 지정하는 방식이다.

중요한 점은 **Render Pass 개념이 완전히 사라지는 것이 아니라**, 사전에 생성하던 `VkRenderPass` 객체와 `VkFramebuffer` 객체가 사라진다는 것이다. `vkCmdBeginRendering`부터 `vkCmdEndRendering`까지는 여전히 하나의 render pass instance처럼 동작한다.

기존 방식:

```cmdstack
VkRenderPass 생성
---
VkFramebuffer 생성
---
VkGraphicsPipelineCreateInfo.renderPass = renderPass
VkGraphicsPipelineCreateInfo.subpass = 0
---
vkCmdBeginRenderPass
draw
vkCmdEndRenderPass
```

Dynamic Rendering 방식:

```cmdstack
VkGraphicsPipelineCreateInfo.renderPass = VK_NULL_HANDLE
VkGraphicsPipelineCreateInfo.pNext = VkPipelineRenderingCreateInfo
---
이미지 레이아웃을 attachment layout으로 전환
---
vkCmdBeginRendering
draw
vkCmdEndRendering
---
필요한 다음 layout으로 직접 전환
```

## 2. 기능 활성화

Vulkan 1.3에서는 core 기능이지만, device 생성 시 `dynamicRendering` feature를 활성화해야 한다. Vulkan 1.2 이하에서 확장으로 쓰면 `VK_KHR_dynamic_rendering`을 enable하고 KHR alias를 사용한다.

```c
VkPhysicalDeviceDynamicRenderingFeatures dynamicRenderingFeatures{};
dynamicRenderingFeatures.sType =
    VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DYNAMIC_RENDERING_FEATURES;
dynamicRenderingFeatures.dynamicRendering = VK_TRUE;

VkDeviceCreateInfo deviceCI{};
deviceCI.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
deviceCI.pNext = &dynamicRenderingFeatures;
// queue, extension, feature 설정...
```

## 3. 파이프라인 생성 시 달라지는 점

기존 그래픽스 파이프라인은 `renderPass`와 `subpass`에 묶인다. Dynamic Rendering에서는 `renderPass = VK_NULL_HANDLE`로 두고, 대신 `VkPipelineRenderingCreateInfo`를 `pNext`에 연결해서 attachment format을 선언한다.

```c
VkFormat colorFormat = swapchainFormat;
VkFormat depthFormat = VK_FORMAT_D32_SFLOAT;

VkPipelineRenderingCreateInfo renderingCI{};
renderingCI.sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO;
renderingCI.colorAttachmentCount = 1;
renderingCI.pColorAttachmentFormats = &colorFormat;
renderingCI.depthAttachmentFormat = depthFormat;
renderingCI.stencilAttachmentFormat = VK_FORMAT_UNDEFINED;

VkGraphicsPipelineCreateInfo pipelineCI{};
pipelineCI.sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO;
pipelineCI.pNext = &renderingCI;
pipelineCI.stageCount = 2;
pipelineCI.pStages = stages;
pipelineCI.pVertexInputState = &vertexInputCI;
pipelineCI.pInputAssemblyState = &iaCI;
pipelineCI.pViewportState = &vpCI;
pipelineCI.pRasterizationState = &rsCI;
pipelineCI.pMultisampleState = &msCI;
pipelineCI.pDepthStencilState = &dsCI;
pipelineCI.pColorBlendState = &cbCI;
pipelineCI.pDynamicState = &dynCI;
pipelineCI.layout = pipelineLayout;
pipelineCI.renderPass = VK_NULL_HANDLE;
pipelineCI.subpass = 0;
```

여기서 `VkPipelineRenderingCreateInfo`는 실제 이미지 뷰를 지정하지 않는다. 파이프라인이 출력할 **포맷 계약**만 정한다. 실제 `VkImageView`, load/store op, clear value, render area는 `vkCmdBeginRendering`에서 지정한다.

| 항목 | 기존 Render Pass | Dynamic Rendering |
|------|------------------|-------------------|
| 파이프라인 생성 | `renderPass` + `subpass` 필요 | `VkPipelineRenderingCreateInfo` 필요 |
| 타겟 포맷 | `VkRenderPass` attachment description에 있음 | pipeline `pNext`에 직접 지정 |
| 실제 이미지 뷰 | `VkFramebuffer`에 있음 | `VkRenderingAttachmentInfo::imageView`에 있음 |
| 렌더 시작 | `vkCmdBeginRenderPass` | `vkCmdBeginRendering` |
| 레이아웃 전환 | render pass description으로 일부 자동화 | 앱이 barrier로 직접 처리 |
| 서브패스 | 지원 | 없음 |

## 4. 포맷 일치 규칙

Dynamic Rendering에서 가장 많이 틀리는 부분은 **pipeline의 attachment format과 begin rendering의 image view format이 맞아야 한다**는 점이다.

```cmdstack
Pipeline 생성 시
VkPipelineRenderingCreateInfo.pColorAttachmentFormats[0] = VK_FORMAT_B8G8R8A8_SRGB
---
Rendering 시작 시
VkRenderingAttachmentInfo.imageView = 같은 format의 swapchain image view
```

규칙은 이렇게 잡으면 된다:

- `colorAttachmentCount`는 fragment output location 개수와 color blend attachment 개수의 기준이 된다.
- `pColorAttachmentFormats[i]`는 rendering 시점의 `pColorAttachments[i].imageView` format과 호환되어야 한다.
- 해당 color slot을 쓰지 않는다면 pipeline 쪽 format을 `VK_FORMAT_UNDEFINED`로 둘 수 있다.
- depth를 쓰면 `depthAttachmentFormat`을 실제 depth image view format과 맞춘다.
- stencil을 쓰면 `stencilAttachmentFormat`을 실제 stencil image view format과 맞춘다.
- depth/stencil attachment를 안 쓰면 해당 format은 `VK_FORMAT_UNDEFINED`다.

예를 들어 color만 있는 swapchain pass라면:

```c
VkPipelineRenderingCreateInfo renderingCI{};
renderingCI.sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO;
renderingCI.colorAttachmentCount = 1;
renderingCI.pColorAttachmentFormats = &swapchainFormat;
renderingCI.depthAttachmentFormat = VK_FORMAT_UNDEFINED;
renderingCI.stencilAttachmentFormat = VK_FORMAT_UNDEFINED;
```

color + depth pass라면:

```c
VkFormat colorFormats[] = {
    VK_FORMAT_R16G16B16A16_SFLOAT,
};

VkPipelineRenderingCreateInfo renderingCI{};
renderingCI.sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO;
renderingCI.colorAttachmentCount = 1;
renderingCI.pColorAttachmentFormats = colorFormats;
renderingCI.depthAttachmentFormat = VK_FORMAT_D32_SFLOAT;
renderingCI.stencilAttachmentFormat = VK_FORMAT_UNDEFINED;
```

G-buffer처럼 color attachment가 여러 개면 pipeline 생성 시의 format 배열 순서가 shader의 output location과 맞아야 한다.

```glsl
layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outNormal;
layout(location = 2) out vec4 outMaterial;
```

```c
VkFormat gbufferFormats[] = {
    VK_FORMAT_R8G8B8A8_SRGB,       // location 0
    VK_FORMAT_A2B10G10R10_UNORM_PACK32, // location 1
    VK_FORMAT_R8G8B8A8_UNORM,      // location 2
};

VkPipelineRenderingCreateInfo renderingCI{};
renderingCI.sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO;
renderingCI.colorAttachmentCount = 3;
renderingCI.pColorAttachmentFormats = gbufferFormats;
renderingCI.depthAttachmentFormat = VK_FORMAT_D32_SFLOAT;
```

## 5. `vkCmdBeginRendering`

실제 렌더 타겟은 `VkRenderingAttachmentInfo`와 `VkRenderingInfo`로 지정한다.

```c
VkRenderingAttachmentInfo colorAttachment{};
colorAttachment.sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO;
colorAttachment.imageView = swapchainImageView;
colorAttachment.imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
colorAttachment.resolveMode = VK_RESOLVE_MODE_NONE;
colorAttachment.resolveImageView = VK_NULL_HANDLE;
colorAttachment.resolveImageLayout = VK_IMAGE_LAYOUT_UNDEFINED;
colorAttachment.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
colorAttachment.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
colorAttachment.clearValue.color = {{0.02f, 0.02f, 0.03f, 1.0f}};

VkRenderingAttachmentInfo depthAttachment{};
depthAttachment.sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO;
depthAttachment.imageView = depthImageView;
depthAttachment.imageLayout = VK_IMAGE_LAYOUT_DEPTH_ATTACHMENT_OPTIMAL;
depthAttachment.resolveMode = VK_RESOLVE_MODE_NONE;
depthAttachment.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
depthAttachment.storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
depthAttachment.clearValue.depthStencil = {1.0f, 0};

VkRenderingInfo renderingInfo{};
renderingInfo.sType = VK_STRUCTURE_TYPE_RENDERING_INFO;
renderingInfo.renderArea.offset = {0, 0};
renderingInfo.renderArea.extent = swapchainExtent;
renderingInfo.layerCount = 1;
renderingInfo.viewMask = 0;
renderingInfo.colorAttachmentCount = 1;
renderingInfo.pColorAttachments = &colorAttachment;
renderingInfo.pDepthAttachment = &depthAttachment;
renderingInfo.pStencilAttachment = nullptr;

vkCmdBeginRendering(cmd, &renderingInfo);
vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS,
    pipelineLayout, 0, 1, &descriptorSet, 0, nullptr);
vkCmdDraw(cmd, vertexCount, 1, 0, 0);
vkCmdEndRendering(cmd);
```

필드 의미:

- `renderArea`: attachment에서 실제로 렌더링할 영역. 0x0이면 아무것도 그리지 않는다.
- `layerCount`: 렌더링할 layer 수. cubemap/array texture 렌더링에서 중요하다.
- `viewMask`: multiview 사용 시 view bitmask. 일반 렌더링은 0.
- `colorAttachmentCount`: color attachment slot 개수.
- `pColorAttachments`: color attachment 배열. pipeline 생성 시 format 배열과 같은 slot 순서를 쓴다.
- `pDepthAttachment`: depth attachment. depth test/write를 쓰면 필요하다.
- `pStencilAttachment`: stencil attachment. stencil test/write를 쓰면 필요하다.

## 6. 레이아웃 전환은 직접 해야 한다

기존 Render Pass는 `initialLayout`, `finalLayout`, subpass layout을 통해 attachment layout transition을 어느 정도 render pass 안에 넣을 수 있었다. Dynamic Rendering은 그런 attachment description이 없으므로, 렌더링 전후의 layout transition을 명령 버퍼에 직접 기록해야 한다.

swapchain color attachment의 전형적인 흐름:

```cmdstack
vkAcquireNextImageKHR
---
swapchain image
PRESENT_SRC_KHR → COLOR_ATTACHMENT_OPTIMAL
---
vkCmdBeginRendering
draw
vkCmdEndRendering
---
swapchain image
COLOR_ATTACHMENT_OPTIMAL → PRESENT_SRC_KHR
---
vkQueuePresentKHR
```

예시 barrier:

```c
VkImageMemoryBarrier2 toColor{};
toColor.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
toColor.srcStageMask = VK_PIPELINE_STAGE_2_NONE;
toColor.srcAccessMask = 0;
toColor.dstStageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT;
toColor.dstAccessMask = VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT;
toColor.oldLayout = VK_IMAGE_LAYOUT_UNDEFINED;
toColor.newLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
toColor.image = swapchainImage;
toColor.subresourceRange.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
toColor.subresourceRange.baseMipLevel = 0;
toColor.subresourceRange.levelCount = 1;
toColor.subresourceRange.baseArrayLayer = 0;
toColor.subresourceRange.layerCount = 1;

VkDependencyInfo dep{};
dep.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
dep.imageMemoryBarrierCount = 1;
dep.pImageMemoryBarriers = &toColor;

vkCmdPipelineBarrier2(cmd, &dep);
```

렌더링 후 present로 넘길 때:

```c
VkImageMemoryBarrier2 toPresent{};
toPresent.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
toPresent.srcStageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT;
toPresent.srcAccessMask = VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT;
toPresent.dstStageMask = VK_PIPELINE_STAGE_2_NONE;
toPresent.dstAccessMask = 0;
toPresent.oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
toPresent.newLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
toPresent.image = swapchainImage;
toPresent.subresourceRange.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
toPresent.subresourceRange.baseMipLevel = 0;
toPresent.subresourceRange.levelCount = 1;
toPresent.subresourceRange.baseArrayLayer = 0;
toPresent.subresourceRange.layerCount = 1;

VkDependencyInfo dep{};
dep.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
dep.imageMemoryBarrierCount = 1;
dep.pImageMemoryBarriers = &toPresent;

vkCmdPipelineBarrier2(cmd, &dep);
```

`oldLayout = VK_IMAGE_LAYOUT_UNDEFINED`는 이전 내용을 버려도 될 때만 사용한다. 이전 frame 결과를 보존해야 하거나 `loadOp = LOAD`를 쓴다면 실제 현재 layout에서 전환해야 한다.

## 7. Load/Store Op와 Clear

Dynamic Rendering에서도 attachment의 load/store 개념은 그대로 있다. 다만 `VkAttachmentDescription`이 아니라 `VkRenderingAttachmentInfo`에 직접 쓴다.

| 목적 | `loadOp` | `storeOp` |
|------|----------|-----------|
| 매 프레임 새로 지우고 그리기 | `CLEAR` | `STORE` |
| 이전 내용 위에 이어 그리기 | `LOAD` | `STORE` |
| depth prepass 후 depth 버릴 때 | `CLEAR` 또는 `LOAD` | `DONT_CARE` |
| 임시 중간 타겟 | 상황에 따라 | `DONT_CARE` 가능 |

`loadOp = CLEAR`일 때만 `clearValue`가 의미 있다. `loadOp = LOAD`를 쓰려면 attachment 이미지의 이전 내용이 유효하고, 그 내용을 읽을 수 있도록 이전 작업과 동기화되어 있어야 한다.

## 8. MSAA와 Resolve

MSAA를 쓰는 경우 파이프라인의 `VkPipelineMultisampleStateCreateInfo::rasterizationSamples`와 attachment sample count가 맞아야 한다. resolve가 필요하면 color attachment에 resolve 대상도 같이 지정한다.

```c
VkRenderingAttachmentInfo msaaColor{};
msaaColor.sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO;
msaaColor.imageView = msaaColorImageView;
msaaColor.imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
msaaColor.resolveMode = VK_RESOLVE_MODE_AVERAGE_BIT;
msaaColor.resolveImageView = swapchainImageView;
msaaColor.resolveImageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
msaaColor.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
msaaColor.storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE;
msaaColor.clearValue.color = {{0.0f, 0.0f, 0.0f, 1.0f}};
```

이 경우 MSAA attachment는 multisampled image이고, resolve image는 single-sampled image다. 둘 다 적절한 layout으로 전환되어 있어야 한다.

## 9. Secondary Command Buffer

Dynamic Rendering 안에서 secondary command buffer를 실행하려면 primary rendering에 `VK_RENDERING_CONTENTS_SECONDARY_COMMAND_BUFFERS_BIT`를 지정한다.

```c
VkRenderingInfo renderingInfo{};
renderingInfo.sType = VK_STRUCTURE_TYPE_RENDERING_INFO;
renderingInfo.flags = VK_RENDERING_CONTENTS_SECONDARY_COMMAND_BUFFERS_BIT;
renderingInfo.renderArea = renderArea;
renderingInfo.layerCount = 1;
renderingInfo.colorAttachmentCount = 1;
renderingInfo.pColorAttachments = &colorAttachment;

vkCmdBeginRendering(primaryCmd, &renderingInfo);
vkCmdExecuteCommands(primaryCmd, secondaryCount, secondaryCmds);
vkCmdEndRendering(primaryCmd);
```

secondary command buffer를 기록할 때는 `VkCommandBufferInheritanceRenderingInfo`를 `VkCommandBufferInheritanceInfo::pNext`에 연결해서 attachment format 정보를 알려줘야 한다.

```c
VkCommandBufferInheritanceRenderingInfo inheritanceRendering{};
inheritanceRendering.sType =
    VK_STRUCTURE_TYPE_COMMAND_BUFFER_INHERITANCE_RENDERING_INFO;
inheritanceRendering.flags = 0;
inheritanceRendering.viewMask = 0;
inheritanceRendering.colorAttachmentCount = 1;
inheritanceRendering.pColorAttachmentFormats = &colorFormat;
inheritanceRendering.depthAttachmentFormat = depthFormat;
inheritanceRendering.stencilAttachmentFormat = VK_FORMAT_UNDEFINED;
inheritanceRendering.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT;

VkCommandBufferInheritanceInfo inheritance{};
inheritance.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_INHERITANCE_INFO;
inheritance.pNext = &inheritanceRendering;

VkCommandBufferBeginInfo beginInfo{};
beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
beginInfo.flags = VK_COMMAND_BUFFER_USAGE_RENDER_PASS_CONTINUE_BIT;
beginInfo.pInheritanceInfo = &inheritance;

vkBeginCommandBuffer(secondaryCmd, &beginInfo);
vkCmdBindPipeline(secondaryCmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
vkCmdDraw(secondaryCmd, vertexCount, 1, 0, 0);
vkEndCommandBuffer(secondaryCmd);
```

secondary command buffer는 `vkCmdBeginRendering`/`vkCmdEndRendering`을 직접 호출하지 않는다. primary가 dynamic rendering scope를 열고, secondary는 그 안에서 실행될 draw command를 담는다.

## 10. Suspend / Resume

`VkRenderingInfo::flags`에는 rendering scope를 나눠 기록하기 위한 플래그도 있다.

- `VK_RENDERING_SUSPENDING_BIT`: 현재 rendering scope를 끝내지 않고 일시 중단한다.
- `VK_RENDERING_RESUMING_BIT`: 이전에 suspend한 rendering scope를 이어받는다.
- `VK_RENDERING_CONTENTS_SECONDARY_COMMAND_BUFFERS_BIT`: 내부 draw가 secondary command buffer로 온다.

suspend/resume은 렌더링 구간 사이에 다른 명령을 끼워 넣기 위한 일반적인 도구가 아니다. 같은 render pass instance를 여러 command buffer 기록 구간으로 나눌 필요가 있을 때 쓰는 기능이고, attachment 정보가 이어지는 구간끼리 일관되어야 한다.

## 11. Input Attachment와 Local Read

기본 Dynamic Rendering에는 기존 subpass가 없다. 그래서 전통적인 Render Pass의 input attachment + `subpassLoad()` 모델을 그대로 가져올 수 없다.

Vulkan 1.4 또는 `VK_KHR_dynamic_rendering_local_read`를 사용하면 Dynamic Rendering에서도 local read 계열 기능을 사용할 수 있다. 이때는 `VkRenderingInputAttachmentIndexInfo` 같은 구조체로 shader input attachment index와 rendering attachment location을 연결한다.

하지만 실무 판단은 여전히 분리해서 봐야 한다:

- 단순 color/depth pass, post-process, swapchain render는 Dynamic Rendering이 간결하다.
- 여러 subpass와 input attachment를 적극적으로 써서 tile memory 최적화를 노리는 모바일/TBDR 경로는 기존 Render Pass가 더 명확할 수 있다.
- Vulkan 1.4 local read는 Dynamic Rendering의 기능 공백을 줄이지만, 기존 subpass 설계를 그대로 대체한다고 가정하면 안 된다.

## 12. 자주 나는 실수

| 증상 | 흔한 원인 |
|------|-----------|
| 파이프라인 생성 실패 | `renderPass = VK_NULL_HANDLE`인데 `VkPipelineRenderingCreateInfo`를 pNext에 안 넣음 |
| validation: format mismatch | pipeline의 color/depth/stencil format과 begin rendering image view format 불일치 |
| 화면이 안 나옴 | swapchain image를 `COLOR_ATTACHMENT_OPTIMAL`로 전환하지 않음 |
| present 실패/경고 | rendering 후 `PRESENT_SRC_KHR`로 전환하지 않음 |
| clear가 안 됨 | `loadOp = CLEAR`가 아니거나 `clearValue`를 다른 attachment에 설정 |
| depth가 이상함 | pipeline depth format, depth image format, `pDepthAttachment` 불일치 |
| secondary command buffer validation | primary에 `VK_RENDERING_CONTENTS_SECONDARY_COMMAND_BUFFERS_BIT` 누락 또는 inheritance format 누락 |
| MSAA validation | pipeline sample count와 attachment sample count 불일치 |

## 13. 선택 기준

Dynamic Rendering을 기본값으로 쓰기 좋은 경우:

- render pass가 하나의 subpass로 끝난다.
- swapchain color + depth처럼 attachment 구성이 단순하다.
- framebuffer 객체를 attachment 조합마다 만들기 싫다.
- 렌더 타겟 조합이 런타임에 자주 바뀐다.
- 데스크탑/현대 Vulkan 1.3+ 경로를 우선한다.

기존 Render Pass가 여전히 좋은 경우:

- 여러 subpass 의존성을 명확히 모델링해야 한다.
- input attachment와 tile memory 최적화가 핵심이다.
- 모바일/TBDR에서 대역폭 최적화가 중요하다.
- legacy Vulkan 1.0/1.1 경로와 호환성이 필요하다.

요약하면, Dynamic Rendering은 **파이프라인을 render pass 객체가 아니라 attachment format 계약에 묶는 방식**이다. 코드 구조는 단순해지지만, 이미지 layout transition과 attachment 일관성은 앱이 더 직접 책임진다.

---
