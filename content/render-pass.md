---
title: Render Pass & 서브패스
slug: render-pass
---

## 소개

서브패스(Subpass)는 Vulkan 렌더 패스를 구성하는 실행 단위다. 하나의 렌더 패스(`VkRenderPass`)는 하나 이상의 서브패스로 나뉘며, 각 서브패스는 동일한 프레임버퍼 어태치먼트(attachment) 집합을 공유하면서 렌더링 파이프라인 단계를 분할 실행한다.

핵심 목적은 타일 기반 렌더링(TBDR, Tile-Based Deferred Rendering) 아키텍처에서 온칩(on-chip) 타일 메모리를 최대한 활용하고, CPU 개입 없이 GPU 내부에서 어태치먼트 데이터를 직접 재사용하여 VRAM 대역폭 소모를 줄이는 데 있다.

| 용어 | 정의 |
|---|---|
| **Attachment** | 색상이나 깊이/스텐실 등 렌더링 결과를 저장하거나 읽는 이미지 뷰 |
| **Framebuffer** | 렌더 패스에서 사용할 어태치먼트 이미지 뷰 바인딩 집합 |
| **Input Attachment** | 프래그먼트 셰이더에서 동일 픽셀 위치의 이전 서브패스 결과를 읽는 특수 어태치먼트 |
| **TBDR** | 화면을 작은 타일 단위로 나누어 온칩 메모리에서 렌더링한 뒤 프레임버퍼로 출력하는 GPU 구조 |

---

## 1. 서브패스 개념

`VkRenderPass` 내의 각 서브패스는 다음 역할을 명시한다:

- 입력(input)으로 읽을 어태치먼트
- 색상(color)으로 출력할 어태치먼트
- 깊이/스텐실(depth/stencil)로 사용할 어태치먼트
- 다중 샘플링 해제(MSAA resolve) 대상 어태치먼트

```c
VkSubpassDescription subpasses[2] = {};

// 서브패스 0: G-Buffer 렌더링 (color 어태치먼트 3개 출력)
subpasses[0].pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
subpasses[0].colorAttachmentCount = 3;
// pColorAttachments = { albedo, normal, roughness }

// 서브패스 1: G-Buffer를 input attachment로 읽어 라이팅 연산 수행
subpasses[1].pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
subpasses[1].inputAttachmentCount = 3;
// pInputAttachments = { albedo, normal, roughness }
subpasses[1].colorAttachmentCount = 1;
// pColorAttachments = { finalColor }
```

서브패스 0에서 색상으로 출력한 어태치먼트를 서브패스 1에서 입력 어태치먼트로 읽는다. TBDR GPU에서는 이 데이터가 VRAM으로 방출(flush)되지 않고 온칩 타일 메모리에 머무르므로 대역폭을 크게 절약한다.

---

## 2. 동작 흐름

서브패스는 단일 렌더 패스 내에서 순차적으로 실행된다. 서브패스 간 전환 시점에는 정의된 의존성에 따라 실행 순서와 메모리 배리어가 적용된다.

```flowchart
flowchart TD
  A["렌더 패스 시작 (vkCmdBeginRenderPass)"]
  B["서브패스 0: G-Buffer 기록"]
  C["vkCmdBindPipeline / vkCmdDraw"]
  D["서브패스 전환 (vkCmdNextSubpass)"]
  E["서브패스 1: 라이팅 연산"]
  F["vkCmdBindPipeline / vkCmdDraw (G-Buffer 입력 읽기)"]
  G["렌더 패스 종료 (vkCmdEndRenderPass)"]
  A --> B --> C --> D --> E --> F --> G
```

서브패스 전환은 명령 버퍼에 `vkCmdNextSubpass`를 기록하여 수행한다.

```c
vkCmdBeginRenderPass(cmdBuffer, &beginInfo, VK_SUBPASS_CONTENTS_INLINE);

// 서브패스 0
vkCmdBindPipeline(cmdBuffer, VK_PIPELINE_BIND_POINT_GRAPHICS, gbufferPipeline);
vkCmdDraw(cmdBuffer, ...);

// 서브패스 1로 전환
vkCmdNextSubpass(cmdBuffer, VK_SUBPASS_CONTENTS_INLINE);

// 서브패스 1
vkCmdBindPipeline(cmdBuffer, VK_PIPELINE_BIND_POINT_GRAPHICS, lightingPipeline);
vkCmdDraw(cmdBuffer, ...);

vkCmdEndRenderPass(cmdBuffer);
```

---

## 3. Subpass Dependency (서브패스 의존성)

서브패스 간 실행 순서와 메모리 가시성, 이미지 레이아웃 자동 전환은 `VkSubpassDependency`로 정의한다. 이전 서브패스의 쓰기 작업이 완료되기 전에 다음 서브패스가 해당 어태치먼트를 읽지 못하도록 동기화 구간을 지정한다.

```c
VkSubpassDependency dependency{};
dependency.srcSubpass = 0;
dependency.dstSubpass = 1;
dependency.srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
dependency.dstStageMask = VK_PIPELINE_STAGE_FRAGMENT_SHADER_BIT;
dependency.srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
dependency.dstAccessMask = VK_ACCESS_INPUT_ATTACHMENT_READ_BIT;
dependency.dependencyFlags = VK_DEPENDENCY_BY_REGION_BIT;
```

`VK_DEPENDENCY_BY_REGION_BIT`는 프레임버퍼 로컬 의존성(framebuffer-local dependency)을 설정한다. 전체 프레임버퍼가 완료될 때까지 기다리지 않고, 동일 타일(픽셀 영역) 내에서 렌더링이 끝난 부분부터 다음 서브패스가 읽도록 제한하여 TBDR 아키텍처의 병렬성을 극대화한다.

### 셀프 서브패스 의존성 (Self-dependency)

`srcSubpass`와 `dstSubpass`를 동일한 서브패스 인덱스로 지정하는 방식이다.

- **용도**: 셀프 의존성은 직접 동기화를 만들지 않는다. 대신 동일 서브패스 내에서 파이프라인 배리어를 사용할 수 있게 해주며, 배리어의 스코프가 서브패스 의존성의 스코프 부분집합이어야 한다.
- **BY_REGION 조건**: 양쪽 스테이지 마스크에 framebuffer-space 스테이지가 포함되면 `VK_DEPENDENCY_BY_REGION_BIT`가 필수다(VUID-VkSubpassDependency-srcSubpass-02243). 다중 뷰 렌더 패스에서는 `VK_DEPENDENCY_VIEW_LOCAL_BIT`도 필요하다(VUID-VkSubpassDependency-srcSubpass-00872).

---

## 4. 서브패스 활용 사례

### 지연 셰이딩 (Deferred Shading)

```
서브패스 0: G-Buffer 생성   →   서브패스 1: 라이팅 연산
(출력: Albedo, Normal, Material)    (입력: Albedo, Normal, Material)
                                    (출력: Final Color)
```

TBDR GPU 환경에서 G-Buffer 텍스처를 VRAM에 쓰지 않고 온칩 타일 메모리에 유지한 채 라이팅 패스가 직접 소비한다.

### 포워드 플러스 / 타일드 라이팅 (Forward+)

```
서브패스 0: 깊이 프리패스 (Depth Pre-pass)
서브패스 1: 얼리 Z(Early-Z) 테스트를 동반한 포워드 렌더링
```

### 후처리 체인 (Post-processing)

```
서브패스 0: 씬 렌더링   →   서브패스 1: 블룸   →   서브패스 2: 톤 매핑
(출력: HDR Color)            (입력: HDR Color)         (입력: Bloom Result)
                            (출력: Bloom Result)      (출력: Final LDR)
```

---

## 5. Input Attachment

Input Attachment는 동일 프레임버퍼에 바인딩된 다른 어태치먼트의 현재 픽셀 값을 셰이더에서 읽어오는 디스크립터 타입이다.

일반 텍스처 샘플링과 달리 임의 좌표 접근이나 텍스처 필터링(sampler)을 지원하지 않는다. 프래그먼트 셰이더가 현재 처리 중인 프래그먼트와 동일한 화면 좌표의 데이터만 로드하므로, TBDR 환경에서 온칩 메모리 레지스터 읽기로 직접 연결된다.

```glsl
// 서브패스 1 프래그먼트 셰이더
layout(input_attachment_index = 0, set = 0, binding = 0) uniform subpassInput gbufferAlbedo;
layout(input_attachment_index = 1, set = 0, binding = 1) uniform subpassInput gbufferNormal;
layout(input_attachment_index = 2, set = 0, binding = 2) uniform subpassInput gbufferRoughness;

layout(location = 0) out vec4 outColor;

void main() {
    vec3 albedo = subpassLoad(gbufferAlbedo).rgb;
    vec3 normal = subpassLoad(gbufferNormal).rgb;
    float roughness = subpassLoad(gbufferRoughness).r;
    
    // 라이팅 계산 및 결과 출력
    outColor = vec4(calculateLighting(albedo, normal, roughness), 1.0);
}
```

| 구분 | 일반 텍스처 | Input Attachment |
|---|---|---|
| **셰이더 인터페이스** | `sampler2D` + `texture()` | `subpassInput` + `subpassLoad()` |
| **이미지 레이아웃** | `VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL` | `VK_IMAGE_LAYOUT_INPUT_ATTACHMENT_OPTIMAL` |
| **샘플러** | 필터링 및 밉맵 샘플러 필요 | 불필요 (현재 픽셀 위치 고정) |
| **메모리 접근** | VRAM 대역폭 소비 | TBDR GPU에서 온칩 타일 메모리 유지 |

---

## 6. VK_KHR_create_renderpass2 (Vulkan 1.2 Core)

Vulkan 1.2부터 코어로 승격된 `VK_KHR_create_renderpass2`는 확장 구조체를 수용할 수 있도록 `pNext` 체인을 지원하는 `VkSubpassDescription2`, `VkSubpassDependency2`, `VkAttachmentDescription2`를 제공한다.

```c
VkAttachmentDescription2 colorAttachment{};
colorAttachment.sType = VK_STRUCTURE_TYPE_ATTACHMENT_DESCRIPTION_2;
colorAttachment.format = VK_FORMAT_B8G8R8A8_SRGB;
colorAttachment.samples = VK_SAMPLE_COUNT_1_BIT;
colorAttachment.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
colorAttachment.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
colorAttachment.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
colorAttachment.finalLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;

VkAttachmentReference2 colorRef{};
colorRef.sType = VK_STRUCTURE_TYPE_ATTACHMENT_REFERENCE_2;
colorRef.attachment = 0;
colorRef.layout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;

VkSubpassDescription2 subpass{};
subpass.sType = VK_STRUCTURE_TYPE_SUBPASS_DESCRIPTION_2;
subpass.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
subpass.viewMask = 0; // 멀티뷰 지원 시 비트마스크 설정
subpass.colorAttachmentCount = 1;
subpass.pColorAttachments = &colorRef;

VkSubpassDependency2 dependency{};
dependency.sType = VK_STRUCTURE_TYPE_SUBPASS_DEPENDENCY_2;
dependency.srcSubpass = VK_SUBPASS_EXTERNAL;
dependency.dstSubpass = 0;
dependency.srcStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
dependency.dstStageMask = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
dependency.srcAccessMask = 0;
dependency.dstAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;

VkRenderPassCreateInfo2 renderPassCI{};
renderPassCI.sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO_2;
renderPassCI.attachmentCount = 1;
renderPassCI.pAttachments = &colorAttachment;
renderPassCI.subpassCount = 1;
renderPassCI.pSubpasses = &subpass;
renderPassCI.dependencyCount = 1;
renderPassCI.pDependencies = &dependency;

VkRenderPass renderPass;
vkCreateRenderPass2(device, &renderPassCI, nullptr, &renderPass);
```

---

## 7. 설계 지침 및 최적화

### TBDR 타일 메모리 최적화

1. **온칩 보존과 Transient 이미지**: 중간 G-Buffer처럼 다음 패스에서 읽고 버릴 이미지는 `VK_IMAGE_USAGE_TRANSIENT_ATTACHMENT_BIT` 플래그와 `VK_MEMORY_PROPERTY_LAZILY_ALLOCATED_BIT` 메모리 타입을 지정한다. GPU가 VRAM 물리 메모리를 실제 할당하지 않고 온칩 타일 메모리만으로 처리할 수 있다.
2. **`loadOp` / `storeOp` 명확화**: 불필요한 VRAM 읽기/쓰기를 피하기 위해 시작 시 `VK_ATTACHMENT_LOAD_OP_CLEAR` 또는 `DONT_CARE`를 사용하고, 프레임버퍼로 출력할 필요가 없는 임시 어태치먼트는 `VK_ATTACHMENT_STORE_OP_DONT_CARE`로 설정한다.
3. **렌더 영역 정렬**: `vkGetRenderAreaGranularity`를 호출하여 얻은 크기의 배수로 `renderArea`를 설정하면 타일 경계 불일치로 인한 추가 로드/스토어 오버헤드를 방지한다.

### Render Pass vs Dynamic Rendering 비교

Vulkan 1.3에 도입된 Dynamic Rendering(`vkCmdBeginRendering`)은 `VkRenderPass`와 `VkFramebuffer` 객체 생성을 생략하여 보일러플레이트를 줄인다. 대상 플랫폼과 파이프라인 요구사항에 따라 적합한 방식을 선택한다.

| 항목 | 기존 Render Pass | Dynamic Rendering (Vulkan 1.3+) |
|---|---|---|
| **객체 관리** | `VkRenderPass`, `VkFramebuffer` 필수 | 객체 생성 불필요 |
| **파이프라인 호환성** | 동일한 렌더 패스 인터페이스 요구 | 어태치먼트 포맷 계약(`VkFormat`)만 일치 |
| **서브패스 지원** | 다중 서브패스 및 온칩 의존성 제어 | 단일 렌더링 범위만 지원 (서브패스 없음) |
| **온칩 로컬 읽기** | `subpassLoad()` 기본 지원 | Vulkan 1.4 `dynamic_rendering_local_read` 필요 |
| **권장 대상** | 모바일/TBDR 대역폭 최적화(Deferred 등) | 데스크톱 GPU, 단순 패스, 동적 렌더 타겟 조합 |

상세한 Dynamic Rendering 구현과 포맷 계약 규칙은 `dynamic-rendering` 토픽을 참조한다.
