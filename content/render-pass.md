---
title: Render Pass & 서브패스
slug: render-pass
---

서브패스(Subpass)는 Vulkan 렌더 패스의 핵심 개념이다. 하나의 렌더 패스는 여러 개의 서브패스로 구성되며, 각 서브패스는 **동일한 framebuffer attachment 집합에 대해 파이프라인의 실행 단위를 나누는 방법**이다.

> **왜 서브패스가 필요할까?** 예를 들어 Deferred Shading을 생각해보자. 먼저 GBuffer에 재질/법선 정보를 그리고, 그 결과를 읽어서 라이팅을 계산한다. 두 단계 모두 같은 버퍼를 쓰는데, 만약 서브패스가 없다면 GBuffer를 VRAM에 썼다가 다시 읽어야 한다. 하지만 서브패스로 나누면 GPU가 **on-chip 메모리에서 바로 읽어가** 쓸 수 있어서 대역폭을 크게 절약한다.

서브패스의 목적은 **타일 기반 GPU(TBDR)에서 on-chip 메모리를 최대한 활용**하고, **호스트(CPU) 개입 없이 GPU 내에서 attachment 데이터를 재사용**하는 데 있다.

> **초보자 용어 정리**
> - **Attachment**: 렌더링 결과를 저장하는 버퍼 (색상, 깊이 등)
> - **Framebuffer**: Attachment들을 묶은 것
> - **Input Attachment**: 다른 서브패스의 결과를 읽는 특수한 방식
> - **TBDR (Tile-Based Deferred Rendering)**: 모바일 GPU의 대표적 구조. 화면을 작은 타일로 나눠서 on-chip에서 처리

---

## 1. 서브패스 개념

Vulkan에서 렌더 패스(`VkRenderPass`)는 하나 이상의 서브패스로 구성된다. 각 서브패스는 다음을 정의한다:

- 어떤 attachment를 **input**으로 읽을지
- 어떤 attachment를 **color**로 쓸지
- 어떤 attachment를 **depth/stencil**로 쓸지
- **resolve** attachment (MSAA)

```c
VkSubpassDescription subpasses[2] = {};

// 서브패스 0: gbuffer에 렌더링 (color 3개 출력)
subpasses[0].pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
subpasses[0].colorAttachmentCount = 3;
// pColorAttachments = { albedo, normal, roughness }

// 서브패스 1: gbuffer를 input으로 읽어서 라이팅 적용
subpasses[1].pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
subpasses[1].inputAttachmentCount = 3;
// pInputAttachments = { albedo, normal, roughness }
subpasses[1].colorAttachmentCount = 1;
// pColorAttachments = { finalColor }
```

중요한 점: **같은 framebuffer attachment**를 서브패스 0에서는 color로 쓰고, 서브패스 1에서는 input attachment로 읽는다. GPU가 attachment 데이터를 VRAM에 쓰지 않고 **on-chip 메모리에서 바로 읽어갈 수 있다면** 엄청난 대역폭 절약이 된다.

---

## 2. 실제 동작 흐름

서브패스는 하나의 렌더 패스 안에서 순차적으로 실행된다. 각 서브패스가 끝나면 자동으로 동기화가 처리된다.

```flowchart
flowchart TD
  A["렌더 패스 시작"]
  B["서브패스 0: GBuffer Pass"]
  C(["vkCmdBindPipeline(..., gbufferPipeline)"])
  D(["vkCmdDraw(...) — albedo, normal, roughness에 씀"])
  E["..."]
  F["서브패스 종료 → 자동 attachment barrier"]
  G["서브패스 1: Lighting Pass"]
  H(["vkCmdBindPipeline(..., lightingPipeline)"])
  I(["vkCmdBindDescriptorSets(...)"])
  J(["vkCmdDraw(...) — gbuffer 결과를 input으로 읽고, finalColor에 씀"])
  K["..."]
  L["서브패스 종료"]
  M["렌더 패스 종료"]
  A --> B --> C --> D --> E --> F --> G --> H --> I --> J --> K --> L --> M
```

서브패스 간 전환은 `vkCmdNextSubpass`로 이루어진다.

```c
vkCmdBeginRenderPass(cmdBuffer, &beginInfo, VK_SUBPASS_CONTENTS_INLINE);

// 서브패스 0
vkCmdDraw(cmdBuffer, ...);

// 서브패스 1로 전환
vkCmdNextSubpass(cmdBuffer, VK_SUBPASS_CONTENTS_INLINE);

// 서브패스 1
vkCmdDraw(cmdBuffer, ...);

vkCmdEndRenderPass(cmdBuffer);
```

---

## 3. Subpass Dependency

서브패스 사이의 의존성은 `VkSubpassDependency`로 정의한다. attachment의 layout 전환과 메모리 가시성을 서브패스 간에 자동으로 처리한다.

> **용도** 서브패스 0에서 쓴 결과를 서브패스 1에서 읽으려면, GPU가 "쓰기가 완료됐다"는 걸 보장해야 한다. 이 의존성을 명시하지 않으면 GPU가 병렬로 실행하다가 잘못된 데이터를 읽을 수 있다.

```c
VkSubpassDependency dependencies[1] = {};

// 서브패스 0(COLOR_OUTPUT) → 서브패스 1(INPUT_ATTACHMENT_READ)
dependencies[0].srcSubpass = 0;
dependencies[0].dstSubpass = 1;
dependencies[0].srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
dependencies[0].dstStageMask = VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT;
dependencies[0].srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
dependencies[0].dstAccessMask = VK_ACCESS_INPUT_ATTACHMENT_READ_BIT;
dependencies[0].dependencyFlags = VK_DEPENDENCY_BY_REGION_BIT;
```

`VK_DEPENDENCY_BY_REGION_BIT`는 **framebuffer-local dependency**를 의미한다. 즉, 서브패스 0에서 실제로 렌더링된 영역(타일)에 대해서만 서브패스 1이 그 결과를 읽을 수 있음을 보장한다. 타일 기반 GPU에서 가장 효율적이다.

**💡 셀프 서브패스 의존성 (Self-dependency)**

`srcSubpass`와 `dstSubpass`를 **동일한 서브패스 인덱스**로 설정하는 경우를 말한다. 이는 주로 다음과 같은 상황에서 사용된다:
- **동일 서브패스 내 읽기/쓰기 반복**: 같은 서브패스 안에서 특정 픽셀에 쓴 내용을 나중에 다시 읽어야 할 때(예: 복잡한 블렌딩이나 특정 연산의 피드백 루프) 필요하다.
- **메모리 가시성 보장**: 동일한 서브패스 내에서도 GPU의 병렬 실행 특성상 쓰기 작업이 완료되기 전에 읽기 작업이 일어날 수 있다. 이때 셀프 의존성을 정의하면, 동일 서브패스 내의 작업 간에도 정확한 실행 순서와 메모리 가시성을 보장할 수 있다.

셀프 의존성을 설정할 때는 반드시 `VK_DEPENDENCY_BY_REGION_BIT` 플래그를 함께 사용하여, 픽셀 단위(타일 단위)의 의존성을 명시해야 GPU가 효율적으로 최적화할 수 있다.

---

## 4. 서브패스의 실제 활용 사례

### Deferred Shading (가장 전형적인 예)

```
Subpass 0: GBuffer   →   Subpass 1: Lighting
(color: albedo, normal, roughness)      (input: albedo, normal, roughness)
                                        (color: finalColor)
```

TBDR 디바이스에서는 GBuffer 데이터가 on-chip 메모리에 남아서, Lighting 패스가 VRAM을 거치지 않고 읽어간다.

### Forward+ / Tiled Lighting

```
Subpass 0: Depth Pre-pass
Subpass 1: Forward rendering (depth test with early-Z)
```

### Post-processing

```
Subpass 0: Scene render   →   Subpass 1: Bloom   →   Subpass 2: Tone mapping
(color: HDR scene)              (input: HDR scene)       (input: bloom result)
                                (color: bloom result)    (color: final LDR)
```

---

## 5. Input Attachment (서브패스의 핵심)

Input attachment는 **같은 framebuffer에 속한 다른 attachment의 픽셀을 셰이더에서 읽는** 특수한 descriptor 타입이다.

> **일반 텍스처와 뭐가 다를까?** 일반 텍스처는 VRAM에서 읽고, 좌표로 원하는 위치를 지정한다. Input Attachment는 **현재 픽셀과 같은 위치의 데이터만** 읽는다._sampler가 필요 없는 이유다. `subpassLoad()`는 항상 "지금 이 픽셀"의 값을 반환한다.

```glsl
// 서브패스 1의 프래그먼트 셰이더
layout(input_attachment_index = 0, set = 0, binding = 0) uniform subpassInput gbufferAlbedo;
layout(input_attachment_index = 1, set = 0, binding = 1) uniform subpassInput gbufferNormal;
layout(input_attachment_index = 2, set = 0, binding = 2) uniform subpassInput gbufferRoughness;

void main() {
    vec3 albedo = subpassLoad(gbufferAlbedo).rgb;
    vec3 normal = subpassLoad(gbufferNormal).rgb;
    float roughness = subpassLoad(gbufferRoughness).r;
    // ... 라이팅 계산
}
```

**차이점:**
| 일반 텍스처 | Input Attachment |
|-----------|----------------|
| `sampler2D` + `texture()` | `subpassInput` + `subpassLoad()` |
| 이미지 레이아웃: `SHADER_READ_ONLY_OPTIMAL` | 레이아웃: `INPUT_ATTACHMENT_OPTIMAL` |
| LOD, sampler 사용 가능 | sampler 불필요 (같은 픽셀 위치) |
| VRAM 대역폭 필요 | Tile 기반 GPU에서 on-chip 가능 |

Input attachment는 **같은 픽셀 위치의 데이터만 읽으므로** sampler가 필요 없다. `subpassLoad()`는 항상 현재 픽셀의 값을 반환한다.

---

## 6. VK_KHR_dynamic_rendering (Vulkan 1.3)

Vulkan 1.3에서 도입된 **Dynamic Rendering**은 렌더 패스 오브젝트를 미리 생성하지 않고, `vkCmdBeginRendering`으로 바로 렌더링을 시작할 수 있게 한다.

> **언제 쓰면 좋을까?** 서브패스가 하나뿐인 단순한 렌더링이라면 Dynamic Rendering이 코드가 훨씬 간결하다. 하지만 서브패스 간 on-chip 최적화가 필요한 Deferred Shading 등은 기존 Render Pass가 더 효율적이다.

```c
// Dynamic Rendering: 렌더 패스 생성 없이 바로 시작
VkRenderingAttachmentInfo colorAttachment{};
colorAttachment.imageView = swapchainImageView;
colorAttachment.imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
colorAttachment.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
colorAttachment.storeOp = VK_ATTACHMENT_STORE_OP_STORE;

VkRenderingInfo renderInfo{};
renderInfo.renderArea = ...;
renderInfo.layerCount = 1;
renderInfo.colorAttachmentCount = 1;
renderInfo.pColorAttachments = &colorAttachment;

vkCmdBeginRendering(cmdBuffer, &renderInfo);
vkCmdDraw(cmdBuffer, ...);
vkCmdEndRendering(cmdBuffer);
```

**Dynamic Rendering vs 기존 서브패스:**

| 항목 | 기존 Render Pass | Dynamic Rendering (Vulkan 1.3) |
|------|-----------------|-------------------------------|
| 사전 생성 | `vkCreateRenderPass` 필요 | 즉시 사용 가능 |
| 서브패스 | 여러 서브패스 가능 | 단일 패스만 (서브패스 없음) |
| 렌더 패스 호환성 | 파이프라인과 render pass 호환 필요 | 파이프라인과 VkFormat만 일치하면 됨 |
| 코드 복잡도 | 낮음 | 낮음 (설정 간소화) |
| TBDR 최적화 | 서브패스 + input attachment로 최적화 | 일반 texture로 fallback |

Vulkan 1.4에서는 `VkRenderingInputAttachmentIndexInfo` 구조체가 추가되어 Dynamic Rendering에서도 input attachment를 사용할 수 있게 되었다. 하지만 엄밀히 말해 Dynamic Rendering은 서브패스를 지원하지 않으며, input attachment로 on-chip 최적화를 받으려면 기존 Render Pass가 필요하다.

> 실무적으로는 **성능이 중요한 TBDR 타겟**이라면 기존 Render Pass + subpass 방식을, **데스크탑/단순 파이프라인**이라면 Dynamic Rendering 방식을 선택하는 추세다.

---

## 7. VK_KHR_create_renderpass2 (Vulkan 1.2)

Vulkan 1.2에서는 `VkSubpassDescription2` / `VkSubpassDependency2`를 도입한 `VK_KHR_create_renderpass2`가 core로 승격되었다.

```c
// Vulkan 1.2 이후: VkSubpassDescription2 사용
VkSubpassDescription2 subpass{};
subpass.sType = VK_STRUCTURE_TYPE_SUBPASS_DESCRIPTION_2;
subpass.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
subpass.viewMask = 0;       // multiview 지원: 렌더링을 브로드캐스트할 뷰 인덱스 비트마스크
// ...
```

`VkAttachmentReference2`의 pNext 체인을 통해 VRS(fragment shading rate), multisample resolve 관련 확장 구조체를 연결할 수 있다. 사실상 `VkSubpassDescription`(Legacy)은 이제 하위 호환성 유지용이다.

---

## 8. 결론

서브패스는 Vulkan 렌더링 파이프라인의 **CPU-GPU 간 동기화를 줄이고**, **tile 기반 GPU에서 대역폭을 절약**하기 위한 장치다.

- **Deferred Shading**, **Post-processing chain**, **MSAA resolve** 등에서 진가를 발휘
- 서브패스 의존성(subpass dependency)을 명시적으로 정의해야 함
- TBDR 디바이스(mobile 등)에서는 거의 필수
- 데스크탑에서는 Dynamic Rendering으로 대체하는 추세
- Vulkan 1.4에서도 계속 발전 중 (`VkRenderingInputAttachmentIndexInfo`)

---

## 9. 렌더 패스 / 서브패스 설계

**핵심**: 모바일·TBDR GPU는 타일 단위로 동작한다. 렌더 패스를 이에 맞게 설계하면 온칩 메모리를 최대한 활용할 수 있다.

### Dynamic Rendering (Vulkan 1.3+)

`VkRenderPass` 없이 `vkCmdBeginRendering`으로 렌더링한다.

- 렌더 패스 **호환성 규칙** 관리 불필요
- **Framebuffer 객체** 생성 불필요
- 단순한 시나리오에서 오버헤드 감소
- 파이프라인 생성 시 attachment 포맷 정보는 여전히 맞춰야 함

### 서브패스 활용

하나의 렌더 패스 안에 여러 서브패스를 정의한다.

- 서브패스 간 **의존성**으로 이미지 레이아웃 자동 전환
- **Input Attachment**로 이전 서브패스 결과를 온칩에서 읽기
- `VK_SUBPASS_CONTENTS_SECONDARY_COMMAND_BUFFERS`로 병렬 커맨드 기록

### 렌더 영역 정렬

`vkGetRenderAreaGranularity`로 타일 경계에 맞춘 `renderArea`를 설정하면 TBDR 효율이 올라간다.

```flowchart
flowchart TD
  A["G-Buffer Pass"]
  B["Subpass 0: Depth + Normal — Input 없음"]
  C["Subpass 1: Lighting — Input: G-Buffer (온칩)"]
  D["Subpass 2: Post — Input: Lighting"]
  A --> B
  A --> C
  A --> D
```

---
