---
title: Dynamic Rendering
slug: dynamic-rendering
---

## 소개

Dynamic Rendering은 `VkRenderPass`와 `VkFramebuffer` 객체를 사전에 생성하지 않고, 명령 버퍼 기록 시점에 `vkCmdBeginRendering`으로 렌더 타깃을 직접 지정하는 렌더링 방식이다. [!badge-info:Vulkan 1.3 Core] `VK_KHR_dynamic_rendering` 확장은 Vulkan 1.3부터 코어로 승격되어 추가 확장 활성화 없이 바로 사용할 수 있다.

이 방식은 렌더 패스 실행 구간 자체를 없애는 것이 아니라 사전 생성 객체(`VkRenderPass`, `VkFramebuffer`)를 생략하는 것이다. `vkCmdBeginRendering`부터 `vkCmdEndRendering`까지의 범위는 여전히 단일 렌더 패스 인스턴스로 동작한다.

### 렌더링 방식 비교

```flowchart
flowchart TD
  subgraph Traditional["기존 렌더 패스 방식"]
    A1["VkRenderPass 생성"] --> A2["VkFramebuffer 생성"]
    A2 --> A3["파이프라인에 renderPass 바인딩"]
    A3 --> A4["vkCmdBeginRenderPass"]
    A4 --> A5["vkCmdDraw"]
    A5 --> A6["vkCmdEndRenderPass"]
  end
  subgraph Dynamic["Dynamic Rendering 방식"]
    B1["VkPipelineRenderingCreateInfo 정의"] --> B2["파이프라인 pNext 연결 (renderPass=NULL)"]
    B2 --> B3["이미지 레이아웃 배리어 직접 기록"]
    B3 --> B4["vkCmdBeginRendering"]
    B4 --> B5["vkCmdDraw"]
    B5 --> B6["vkCmdEndRendering"]
    B6 --> B7["다음 작업에 맞춘 레이아웃 배리어 기록"]
  end
```

---

## 1. 기능 활성화

Vulkan 1.3에서는 디바이스 생성 시 `VkPhysicalDeviceDynamicRenderingFeatures` 구조체를 통해 `dynamicRendering` 기능을 활성화해야 한다. Vulkan 1.2 이하 환경에서 확장으로 사용할 때는 `VK_KHR_dynamic_rendering` 디바이스 확장을 명시하고 KHR 별칭 함수를 호출한다.

```c
VkPhysicalDeviceDynamicRenderingFeatures dynamicRenderingFeatures{};
dynamicRenderingFeatures.sType =
    VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DYNAMIC_RENDERING_FEATURES;
dynamicRenderingFeatures.dynamicRendering = VK_TRUE;

VkDeviceCreateInfo deviceCI{};
deviceCI.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
deviceCI.pNext = &dynamicRenderingFeatures;
// 큐, 확장, 기본 기능 설정...
```

---

## 2. 파이프라인 생성과 포맷 계약

기존 그래픽스 파이프라인은 특정 `VkRenderPass`와 서브패스 인덱스에 결합된다. Dynamic Rendering에서는 파이프라인 생성 시 `renderPass = VK_NULL_HANDLE`로 지정하고, `VkPipelineRenderingCreateInfo`를 `VkGraphicsPipelineCreateInfo::pNext` 체인에 연결하여 어태치먼트 포맷을 선언한다.

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

`VkPipelineRenderingCreateInfo`는 실제 이미지 뷰를 참조하지 않으며 파이프라인이 출력할 **포맷 계약(Format Contract)**만 정의한다. 실제 `VkImageView`, 로드/스토어 연산(`loadOp`/`storeOp`), 클리어 값, 렌더링 영역(`renderArea`)은 명령 기록 시점인 `vkCmdBeginRendering`에서 전달한다.

| 항목 | 기존 Render Pass | Dynamic Rendering |
|---|---|---|
| **파이프라인 생성** | `renderPass` 및 `subpass` 지정 | `VkPipelineRenderingCreateInfo` (`renderPass = NULL`) |
| **타깃 포맷 명시** | `VkRenderPass` 어태치먼트 기술자 | 파이프라인 `pNext`에 포맷 배열 전달 |
| **실제 이미지 바인딩** | `VkFramebuffer` 사전 생성 | `VkRenderingAttachmentInfo::imageView` 전달 |
| **렌더링 시작** | `vkCmdBeginRenderPass` | `vkCmdBeginRendering` |
| **레이아웃 전환** | 서브패스 및 렌더 패스 정의로 자동화 | 명령 버퍼에 파이프라인 배리어 직접 기록 |
| **서브패스 지원** | 다중 서브패스 분할 가능 | 단일 패스 구조 (서브패스 미지원) |

---

## 3. 포맷 일치 규칙

Dynamic Rendering에서 파이프라인 생성 시 선언한 포맷과 `vkCmdBeginRendering` 시 바인딩하는 이미지 뷰 포맷은 정확히 일치해야 한다.

- `colorAttachmentCount`는 프래그먼트 셰이더 출력 위치(`location`) 개수 및 블렌드 상태의 기준이다.
- `pColorAttachmentFormats[i]`는 렌더링 시점의 `pColorAttachments[i].imageView` 포맷과 **정확히 일치(equal)**해야 한다(VUID-vkCmdDraw-dynamicRenderingUnusedAttachments-08914).
- 특정 색상 슬롯을 사용하지 않는 경우 파이프라인 포맷을 `VK_FORMAT_UNDEFINED`로 지정할 수 있다.
- 깊이 버퍼를 사용하는 경우 `depthAttachmentFormat`을 바인딩할 깊이 이미지 뷰 포맷과 일치시킨다.
- 스텐실 버퍼를 사용하는 경우 `stencilAttachmentFormat`을 실제 스텐실 이미지 뷰 포맷과 일치시킨다.
- 깊이나 스텐실 어태치먼트를 사용하지 않을 때는 해당 포맷을 `VK_FORMAT_UNDEFINED`로 설정한다.

### 다중 어태치먼트 (G-Buffer 예시)

색상 출력이 여러 개인 경우 파이프라인 포맷 배열의 순서는 셰이더의 `layout(location = ...)` 순서와 일치해야 한다.

```glsl
layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outNormal;
layout(location = 2) out vec4 outMaterial;
```

```c
VkFormat gbufferFormats[] = {
    VK_FORMAT_R8G8B8A8_SRGB,            // location 0
    VK_FORMAT_A2B10G10R10_UNORM_PACK32, // location 1
    VK_FORMAT_R8G8B8A8_UNORM,           // location 2
};

VkPipelineRenderingCreateInfo renderingCI{};
renderingCI.sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO;
renderingCI.colorAttachmentCount = 3;
renderingCI.pColorAttachmentFormats = gbufferFormats;
renderingCI.depthAttachmentFormat = VK_FORMAT_D32_SFLOAT;
renderingCI.stencilAttachmentFormat = VK_FORMAT_UNDEFINED;
```

---

## 4. `vkCmdBeginRendering` 명령 기록

렌더 타깃 설정은 `VkRenderingAttachmentInfo`와 `VkRenderingInfo`를 작성하여 전달한다.

```c
VkRenderingAttachmentInfo colorAttachment{};
colorAttachment.sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO;
colorAttachment.imageView = swapchainImageView;
colorAttachment.imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
colorAttachment.resolveMode = VK_RESOLVE_MODE_NONE;
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

### 주요 필드 명세

- `renderArea`: 어태치먼트 내에서 렌더링을 수행할 사각형 영역. 가로/세로가 0이면 그리지 않는다.
- `layerCount`: 렌더링 대상 레이어 수(큐브맵이나 텍스처 배열 렌더링 시 지정).
- `viewMask`: 멀티뷰 렌더링 시 대상 뷰 비트마스크(일반 렌더링은 0).
- `pColorAttachments`: 색상 어태치먼트 구조체 배열. 파이프라인 생성 시 등록한 포맷 순서와 일치해야 한다.
- `pDepthAttachment` / `pStencilAttachment`: 깊이 및 스텐실 테스트/쓰기용 어태치먼트 정보.

---

## 5. 이미지 레이아웃 전환

기존 렌더 패스는 `initialLayout`과 `finalLayout`을 통해 어태치먼트 레이아웃 전환을 자동 수행했으나, Dynamic Rendering은 어태치먼트 기술자가 없으므로 렌더링 전후의 레이아웃 배리어를 명령 버퍼에 직접 기록해야 한다.

스왑체인 이미지의 전형적인 레이아웃 전환 절차:

```
vkAcquireNextImageKHR
  → 배리어: UNDEFINED (또는 PRESENT_SRC_KHR) → COLOR_ATTACHMENT_OPTIMAL
  → vkCmdBeginRendering
  → 드로우 콜 기록
  → vkCmdEndRendering
  → 배리어: COLOR_ATTACHMENT_OPTIMAL → PRESENT_SRC_KHR
  → vkQueuePresentKHR
```

```c
// 렌더링 전: COLOR_ATTACHMENT_OPTIMAL로 전환
VkImageMemoryBarrier2 toColor{};
toColor.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
toColor.srcStageMask = VK_PIPELINE_STAGE_2_NONE;
toColor.srcAccessMask = 0;
toColor.dstStageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT;
toColor.dstAccessMask = VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT;
toColor.oldLayout = VK_IMAGE_LAYOUT_UNDEFINED;
toColor.newLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
toColor.image = swapchainImage;
toColor.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};

VkDependencyInfo depInfo{};
depInfo.sType = VK_STRUCTURE_TYPE_DEPENDENCY_INFO;
depInfo.imageMemoryBarrierCount = 1;
depInfo.pImageMemoryBarriers = &toColor;
vkCmdPipelineBarrier2(cmd, &depInfo);
```

```c
// 렌더링 후: PRESENT_SRC_KHR로 전환
VkImageMemoryBarrier2 toPresent{};
toPresent.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER_2;
toPresent.srcStageMask = VK_PIPELINE_STAGE_2_COLOR_ATTACHMENT_OUTPUT_BIT;
toPresent.srcAccessMask = VK_ACCESS_2_COLOR_ATTACHMENT_WRITE_BIT;
toPresent.dstStageMask = VK_PIPELINE_STAGE_2_NONE;
toPresent.dstAccessMask = 0;
toPresent.oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
toPresent.newLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;
toPresent.image = swapchainImage;
toPresent.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};

depInfo.pImageMemoryBarriers = &toPresent;
vkCmdPipelineBarrier2(cmd, &depInfo);
```

> `oldLayout = VK_IMAGE_LAYOUT_UNDEFINED`는 이전 픽셀 내용을 버릴 때만 유효하다. 이전 프레임 결과를 유지하거나 `loadOp = VK_ATTACHMENT_LOAD_OP_LOAD`를 적용할 때는 실제 이전 레이아웃을 정확히 명시해야 한다.

---

## 6. 어태치먼트 연산 (Load / Store / MSAA Resolve)

`VkRenderingAttachmentInfo`에서 로드/스토어 동작을 직접 정의한다.

| 목적 | `loadOp` | `storeOp` |
|---|---|---|
| 프레임 시작 시 지우고 새로 그리기 | `CLEAR` | `STORE` |
| 이전 결과물 위에 덮어 그리기 | `LOAD` | `STORE` |
| 깊이 프리패스 후 깊이 버퍼 폐기 | `CLEAR` 또는 `LOAD` | `DONT_CARE` |
| 임시 중간 텍스처 | 용도에 따름 | `DONT_CARE` |

`loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR`일 때만 `clearValue`가 유효하다. `LOAD`를 사용할 때는 이전 작업의 쓰기가 완료되고 레이아웃이 유효하도록 동기화가 선행되어야 한다.

### 다중 샘플링 및 리졸브 (MSAA Resolve)

MSAA를 활성화할 때는 파이프라인의 `VkPipelineMultisampleStateCreateInfo::rasterizationSamples`와 어태치먼트의 샘플 수가 일치해야 한다. 렌더링과 동시에 단일 샘플 이미지로 리졸브하려면 어태치먼트 구조체에 리졸브 대상을 함께 지정한다.

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

---

## 7. 세컨더리 커맨드 버퍼 상속

Dynamic Rendering 범위 내부에서 세컨더리 커맨드 버퍼(`VkCommandBuffer`)를 실행하려면 프라이머리 렌더링 플래그에 `VK_RENDERING_CONTENTS_SECONDARY_COMMAND_BUFFERS_BIT`를 지정한다.

```c
VkRenderingInfo renderingInfo{};
renderingInfo.sType = VK_STRUCTURE_TYPE_RENDERING_INFO;
renderingInfo.flags = VK_RENDERING_CONTENTS_SECONDARY_COMMAND_BUFFERS_BIT;
// ... 어태치먼트 설정 ...

vkCmdBeginRendering(primaryCmd, &renderingInfo);
vkCmdExecuteCommands(primaryCmd, secondaryCount, secondaryCmds);
vkCmdEndRendering(primaryCmd);
```

세컨더리 커맨드 버퍼 기록 시에는 `VkCommandBufferInheritanceRenderingInfo`를 `VkCommandBufferInheritanceInfo::pNext` 체인에 연결하여 프라이머리와 동일한 어태치먼트 포맷 및 샘플 수 정보를 전달해야 한다.

```c
VkCommandBufferInheritanceRenderingInfo inheritanceRendering{};
inheritanceRendering.sType =
    VK_STRUCTURE_TYPE_COMMAND_BUFFER_INHERITANCE_RENDERING_INFO;
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

세컨더리 커맨드 버퍼 내부에서는 `vkCmdBeginRendering`이나 `vkCmdEndRendering`을 호출할 수 없다. 프라이머리 커맨드 버퍼가 연 렌더링 범위 내에서 드로우 명령만 수행한다.

---

## 8. Suspend 및 Resume

`VkRenderingInfo::flags`를 활용하면 단일 렌더 패스 범위를 분할 기록할 수 있다.

- `VK_RENDERING_SUSPENDING_BIT`: 현재 렌더링 범위를 완료하지 않고 일시 중단한다.
- `VK_RENDERING_RESUMING_BIT`: 이전에 일시 중단한 렌더링 범위를 이어서 재개한다.

이 플래그는 렌더링 도중 임의의 다른 파이프라인 작업을 삽입하기 위한 용도가 아니다. 동일한 렌더 패스 인스턴스를 여러 명령 버퍼 제출 단위로 분할해야 할 때 사용하며, 연결되는 구간의 어태치먼트 구성과 포맷이 일치해야 한다.

---

## 9. 로컬 읽기(Local Read)와 서브패스 대체

기본 Dynamic Rendering은 서브패스 개념을 지원하지 않으므로 전통적인 `subpassLoad()`를 직접 사용할 수 없다.

Vulkan 1.4 또는 `VK_KHR_dynamic_rendering_local_read` 확장을 사용하고 `dynamicRenderingLocalRead` 피처를 활성화하면, `VkRenderingInputAttachmentIndexInfo` 구조체(또는 `vkCmdSetRenderingInputAttachmentIndicesKHR`)로 셰이더 입력 어태치먼트 인덱스와 렌더링 어태치먼트 위치를 매핑해 로컬 읽기가 가능하다. 이때 입력 첨부로 읽힐 이미지는 `VK_IMAGE_LAYOUT_RENDERING_LOCAL_READ_KHR` 레이아웃으로 전환되어 있어야 한다.

### Dynamic Rendering vs Render Pass 선택 기준

- 단순 색상/깊이 렌더링, 포스트 프로세싱, 스왑체인 출력 → **Dynamic Rendering** 권장
- 렌더 타겟 조합이 런타임에 자주 바뀐다 → **Dynamic Rendering**
- 파이프라인 생성 시 렌더 패스 객체 의존성을 제거하고 싶다 → **Dynamic Rendering**
- 멀티샘플(MSAA) 어테치먼트와 리졸브 이미지를 동시에 관리 → **Dynamic Rendering** (단, MSAA·리졸브 이미지 모두 적절한 레이아웃 전환 필요)
- G-Buffer 대역폭 최적화가 중요한 모바일/TBDR 다중 패스 → **전통적 VkRenderPass** 서브패스가 직관적
- 서브패스 간 자동 메모리 의존성 관리를 원함 → **전통적 VkRenderPass**
- 기존 코드베이스가 VkRenderPass 기반 → 마이그레이션 비용 고려

---

## 10. 문제 해결 가이드

| 발생 현상 | 주요 원인 및 조치 |
|---|---|
| **파이프라인 생성 오류** | `renderPass = VK_NULL_HANDLE`인데 `VkPipelineRenderingCreateInfo`를 `pNext`에 누락함 |
| **어태치먼트 포맷 불일치 경고** | 파이프라인 포맷 배열과 `vkCmdBeginRendering` 이미지 뷰 포맷 불일치 |
| **화면 미출력(검은 화면)** | 렌더링 전 스왑체인 이미지를 `COLOR_ATTACHMENT_OPTIMAL`로 전환하지 않음 |
| **프레젠테이션 실패** | 렌더링 종료 후 이미지를 `PRESENT_SRC_KHR` 레이아웃으로 전환하지 않음 |
| **클리어 미작동** | `loadOp`가 `CLEAR`가 아니거나 `clearValue`를 엉뚱한 어태치먼트에 할당함 |
| **깊이 판정 오류** | 파이프라인, 이미지 뷰, `pDepthAttachment`의 포맷 불일치 |
| **세컨더리 버퍼 검증 실패** | 프라이머리의 `SECONDARY_COMMAND_BUFFERS_BIT` 누락 또는 상속 포맷 불일치 |
| **MSAA 검증 실패** | 파이프라인 래스터화 샘플 수와 어태치먼트 샘플 수 불일치 |

---

## 11. 요약

Dynamic Rendering은 그래픽스 파이프라인을 특정 `VkRenderPass` 객체 대신 **어태치먼트 포맷 계약**에 결합하는 방식이다. `VkRenderPass` 및 `VkFramebuffer` 객체 생성과 호환성 관리 비용이 사라지는 대신, 이미지 레이아웃 전환과 동기화 배리어는 애플리케이션이 직접 명령 버퍼에 기록해야 한다.
