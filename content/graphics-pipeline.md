---
title: 그래픽스 파이프라인
slug: graphics-pipeline
---

## 소개

Vulkan의 그래픽스 파이프라인(VkGraphicsPipeline)은 셰이더 단계와 고정 함수 단계를 **명시적으로 조립**해서 만든다. `VkGraphicsPipelineCreateInfo` 하나에 필요한 모든 상태를 한꺼번에 전달해야 하며, OpenGL처럼 중간에 상태를 바꾸는 방식이 아니다.

> **왜 이렇게 복잡할까?** OpenGL은 "현재 상태"를 바꾸는 방식이라 유연했지만, 드라이버가 매번 상태를 확인해야 해서 성능이 떨어졌다. Vulkan은 "모든 상태를 한 번에 선언"하는 방식으로, GPU가 미리 최적화할 수 있게 한다. 처음엔 복잡해도 한번 만들어두면 재사용할 수 있다.

> **용어 정리**
> - **고정 함수 유닛(FFU)**: 프로그래머가 제어할 수 없는 GPU 내부 단계 (래스터화, 블렌딩 등)
> - **프로그래머블 셰이더**: 개발자가 코드를 작성하는 단계 (버텍스, 프래그먼트 등)
> - **파이프라인 상태 객체(PSO)**: 파이프라인 설정을 묶은 객체. 한 번 만들면 변경 불가

---

---

## 1. 파이프라인의 구조 (요약)

Vulkan 그래픽스 파이프라인은 다음과 같은 **고정 함수 유닛(FFU)** 과 **프로그래머블 셰이더**의 조합이다.

> **흐름 이해**: 버텍스 버퍼 → 정점 처리 → 래스터화(삼각형을 픽셀로) → 프래그먼트 처리 → 색상 출력. 이 흐름을 따라가면서 각 단계가 어떻게 설정되는지 보면 이해하기 쉽다.

```cmdstack
Vertex Input Buffer
---
vertex input (VB/IB → 속성) ← VkPipelineVertexInputStateCreateInfo · 고정
---
input assembly (정점 → 프리미티브) ← VkPipelineInputAssemblyStateCreateInfo · 고정
---
vertex shader ← 프로그래머블
---
tessellation (옵션) ← VkPipelineTessellationStateCreateInfo · 고정
control shader ← 프로그래머블
evaluation shader ← 프로그래머블
---
geometry shader (옵션) ← 프로그래머블
---
rasterization (정점 → 프래그먼트) ← VkPipelineRasterizationStateCreateInfo · 고정
cull mode, front face, depth bias, polygon mode
---
multisampling (MSAA) ← VkPipelineMultisampleStateCreateInfo · 고정
---
depth/stencil ← VkPipelineDepthStencilStateCreateInfo · 고정
---
fragment shader ← 프로그래머블
---
color blending ← VkPipelineColorBlendStateCreateInfo · 고정
---
Framebuffer
```

스펙(10.4. Graphics Pipelines)은 이 상태들을 4개의 **논리적 그룹**으로 나눈다:

| 그룹 | 포함 상태 | 비고 |
|------|---------|------|
| **Vertex Input State** | VertexInput + InputAssembly | 버텍스 데이터를 어떻게 읽을지 |
| **Pre-rasterization Shader State** | VS/TCS/TES/GS + Tessellation + Viewport + Rasterization | 래스터화 전 모든 것 |
| **Fragment Shader State** | Fragment Shader | FS만 |
| **Fragment Output State** | ColorBlend (attachments) + DepthStencil | 프래그먼트 출력 |

---

---

## 2. `VkGraphicsPipelineCreateInfo` 구조체

```c
typedef struct VkGraphicsPipelineCreateInfo {
    VkStructureType                             sType;
    const void*                                 pNext;
    VkPipelineCreateFlags                       flags;
    uint32_t                                    stageCount;
    const VkPipelineShaderStageCreateInfo*      pStages;
    const VkPipelineVertexInputStateCreateInfo* pVertexInputState;
    const VkPipelineInputAssemblyStateCreateInfo* pInputAssemblyState;
    const VkPipelineTessellationStateCreateInfo* pTessellationState;
    const VkPipelineViewportStateCreateInfo*    pViewportState;
    const VkPipelineRasterizationStateCreateInfo* pRasterizationState;
    const VkPipelineMultisampleStateCreateInfo* pMultisampleState;
    const VkPipelineDepthStencilStateCreateInfo* pDepthStencilState;
    const VkPipelineColorBlendStateCreateInfo*  pColorBlendState;
    const VkPipelineDynamicStateCreateInfo*     pDynamicState;
    VkPipelineLayout                            layout;
    VkRenderPass                                renderPass;
    uint32_t                                    subpass;
    VkPipeline                                  basePipelineHandle;
    int32_t                                     basePipelineIndex;
} VkGraphicsPipelineCreateInfo;
```

**핵심 포인트:**
- `pVertexInputState` / `pInputAssemblyState` 등 각 포인터는 **NULL이 될 수 있음** (`VK_DYNAMIC_STATE_*`으로 동적 상태로 만들면 실제 값은 나중에 설정)
- `renderPass` + `subpass`: 어떤 render pass의 어떤 subpass에서 사용될지 지정. 파이프라인은 이 render pass와 호환되는 프레임버퍼에서만 사용 가능.
- `layout`: descriptor set layout + push constant range

---

---

## 3. Vertex Input State (버텍스 입력)

두 가지 구조체로 구성된다.

> **용도** GPU는 "버퍼의 어디부터 어디까지가 어떤 데이터인지" 알아야 한다. Vertex Input State는 "이 버퍼의 0바이트부터 position이고, 12바이트부터 normal이다"라고 알려주는 설정이다.

### 3.1. Vertex Input Binding (버퍼 → 버텍스 스트림)

```c
VkVertexInputBindingDescription bindings[2] = {};
bindings[0].binding = 0;              // binding slot 0
bindings[0].stride = sizeof(Vertex);   // 정점 하나당 바이트
bindings[0].inputRate = VK_VERTEX_INPUT_RATE_VERTEX; // per-vertex

bindings[1].binding = 1;
bindings[1].stride = sizeof(InstanceData);
bindings[1].inputRate = VK_VERTEX_INPUT_RATE_INSTANCE; // per-instance
```

`inputRate`:
- `VK_VERTEX_INPUT_RATE_VERTEX`: 매 정점마다 다음 속성으로 이동
- `VK_VERTEX_INPUT_RATE_INSTANCE`: 매 인스턴스마다 다음 속성으로 이동 (instancing)

### 3.2. Vertex Input Attribute (버퍼 내 위치 → 셰이더 location)

```c
VkVertexInputAttributeDescription attributes[3] = {};
attributes[0].location = 0;               // shader의 layout(location = 0)
attributes[0].binding = 0;                // binding slot 0
attributes[0].format = VK_FORMAT_R32G32B32_SFLOAT; // vec3
attributes[0].offset = offsetof(Vertex, pos);

attributes[1].location = 1;
attributes[1].binding = 0;
attributes[1].format = VK_FORMAT_R32G32B32_SFLOAT; // vec3 (normal)
attributes[1].offset = offsetof(Vertex, normal);

attributes[2].location = 2;
attributes[2].binding = 1;
attributes[2].format = VK_FORMAT_R32G32B32A32_SFLOAT; // vec4 (instance color)
attributes[2].offset = offsetof(InstanceData, color);
```

**셰이더 측:**
```glsl
layout(location = 0) in vec3 inPos;
layout(location = 1) in vec3 inNormal;
layout(location = 2) in vec4 inInstanceColor; // per-instance
```

**중요:** `VkVertexInputAttributeDescription::format`은 **GPU가 버퍼에서 읽는 형식**을 지정한다. 셰이더에서 `vec3`로 받을 거라면 `R32G32B32_SFLOAT`으로 설정한다. 64비트 컴포넌트(R64G64_SFLOAT 등)가 있으면 해당 location에서 사용하지 않는 컴포넌트가 없어야 한다 (스펙 VUID).

### 3.3. Input Assembly (정점 → 삼각형)

```c
VkPipelineInputAssemblyStateCreateInfo iaCI{};
iaCI.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
iaCI.primitiveRestartEnable = VK_FALSE;
```

`topology` 옵션:
| 값 | 의미 |
|-----|------|
| `POINT_LIST` | 점 |
| `LINE_LIST` / `LINE_STRIP` | 선 |
| `TRIANGLE_LIST` / `TRIANGLE_STRIP` / `TRIANGLE_FAN` | 삼각형 |
| `TRIANGLE_LIST_WITH_ADJACENCY` 등 | 인접 정보 포함 (GS용) |
| `PATCH_LIST` | 테셀레이션용 (patchControlPoints 설정 필요) |

---

---

## 4. Tessellation State (테셀레이션)

테셀레이션을 사용하려면 `VK_PRIMITIVE_TOPOLOGY_PATCH_LIST`를 지정하고, `VkPipelineTessellationStateCreateInfo`를 설정한다.

```c
VkPipelineTessellationStateCreateInfo tessCI{};
tessCI.patchControlPoints = 3; // 패치당 제어점 개수
```

셰이더 측에서는 TCS(Tessellation Control Shader)와 TES(Tessellation Evaluation Shader)가 필요하다.

```glsl
// TCS: 출력 테셀레이션 레벨 지정
layout(vertices = 3) out;
void main() {
    gl_TessLevelOuter[0] = gl_TessLevelOuter[1] = gl_TessLevelOuter[2] = 4.0;
    gl_TessLevelInner[0] = 4.0;
}

// TES: 테셀레이션된 좌표에서 최종 위치 계산
layout(triangles, equal_spacing, cw) in;
void main() {
    gl_Position = gl_in[0].gl_Position * gl_TessCoord.x
                + gl_in[1].gl_Position * gl_TessCoord.y
                + gl_in[2].gl_Position * gl_TessCoord.z;
}
```

---

---

## 5. Viewport State (뷰포트와 가위)

```c
VkViewport viewport{};
viewport.x = 0; viewport.y = 0;
viewport.width = 1920; viewport.height = 1080;
viewport.minDepth = 0.0f; viewport.maxDepth = 1.0f;

VkRect2D scissor{};
scissor.offset = {0, 0};
scissor.extent = {1920, 1080};

VkPipelineViewportStateCreateInfo vpCI{};
vpCI.viewportCount = 1;
vpCI.pViewports = &viewport;
vpCI.scissorCount = 1;
vpCI.pScissors = &scissor;
```

**동적 상태 사용:** `pViewports`와 `pScissors` 대신 `pDynamicState`에 `VK_DYNAMIC_STATE_VIEWPORT`와 `VK_DYNAMIC_STATE_SCISSOR`를 추가하면, `vkCmdSetViewport` / `vkCmdSetScissor`로 런타임에 설정 가능. 멀티뷰포트도 지원한다.

---

---

## 6. Rasterization State (래스터화)

래스터화는 **삼각형을 픽셀(프래그먼트)로 변환**하는 단계다.

> **핵심 개념**: GPU는 정점 3개로 삼각형을 그리지만, 실제 화면은 픽셀의 격자다. 래스터화는 "이 삼각형이 어떤 픽셀을 덮는지"를 결정하는 과정이다.

```c
VkPipelineRasterizationStateCreateInfo rsCI{};
rsCI.depthClampEnable = VK_FALSE;     // 깊이 클램핑 (Near/Far 밖도 허용)
rsCI.rasterizerDiscardEnable = VK_FALSE; // true면 프래그먼트 안 만듦
rsCI.polygonMode = VK_POLYGON_MODE_FILL; // FILL, LINE, POINT
rsCI.cullMode = VK_CULL_MODE_BACK_BIT;   // CULL_NONE, FRONT, BACK, FRONT_AND_BACK
rsCI.frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE; // CCW / CW
rsCI.depthBiasEnable = VK_FALSE;
rsCI.depthBiasConstantFactor = 0.0f;
rsCI.depthBiasClamp = 0.0f;
rsCI.depthBiasSlopeFactor = 0.0f;
rsCI.lineWidth = 1.0f;
```

**핵심 필드:**
- `rasterizerDiscardEnable`: `VK_TRUE`면 래스터화 자체를 생략. Depth pass 최적화 등에 사용. 이 값이 `VK_TRUE`면 `ViewportState`, `Multisample`, `DepthStencil`, `ColorBlend`는 필요하지 않음.
- `polygonMode`: `VK_POLYGON_MODE_FILL`이 기본. `LINE`은 와이어프레임, `POINT`는 점. `LINE` / `POINT`는 `fillModeNonSolid` feature 필요.
- `cullMode`: 뒷면 컬링. `VK_CULL_MODE_NONE`이면 양면 모두 그림.
- `frontFace`: `CCW` / `CW`. 정점 순서에 따라 앞면 결정.

---

---

## 7. Multisample State (MSAA)

MSAA(Multisample Anti-Aliasing)는 **기하학적 경계에서의 계단 현상을 줄이는 기법**이다.

```c
VkPipelineMultisampleStateCreateInfo msCI{};
msCI.rasterizationSamples = VK_SAMPLE_COUNT_4_BIT; // 1, 2, 4, 8
msCI.sampleShadingEnable = VK_FALSE;
msCI.minSampleShading = 1.0f;
msCI.pSampleMask = nullptr;
msCI.alphaToCoverageEnable = VK_FALSE;
msCI.alphaToOneEnable = VK_FALSE;
```

- `rasterizationSamples`: `VK_SAMPLE_COUNT_1_BIT`이면 MSAA 없음
### 7.1. Sample Shading (= SSAA)

`sampleShadingEnable = VK_TRUE`를 켜면 **Fragment Shader가 픽셀당 한 번이 아니라, 샘플당 한 번씩 실행**된다. 이는 **SSAA(Super-Sampling Anti-Aliasing)** 와 동일한 원리다.

```c
// MSAA만: FS는 픽셀당 1번, 결과를 4개 샘플에 복제
msCI.rasterizationSamples = VK_SAMPLE_COUNT_4_BIT;
msCI.sampleShadingEnable = VK_FALSE;  // 기본값: FS per-pixel

// Sample Shading = SSAA: FS가 샘플당 1번씩 실행
msCI.rasterizationSamples = VK_SAMPLE_COUNT_4_BIT;
msCI.sampleShadingEnable = VK_TRUE;
msCI.minSampleShading = 1.0f;  // 모든 샘플에 대해 FS 실행
```

**동작 방식:**

| 모드 | FS 실행 횟수 | 각 FS의 위치 | 효과 |
|------|------------|------------|------|
| MSAA only | 1회/픽셀 | 픽셀 중심 (고정) | 기하 경계만 안티앨리어싱 |
| Sample Shading = 0.25 | 1~4회/픽셀 | 일부 샘플 위치 | 중간 품질 |
| Sample Shading = 1.0 | N회/픽셀 (N = 샘플 수) | **각 샘플 위치** | **완전한 SSAA** |

`minSampleShading = 1.0f` + `rasterizationSamples = VK_SAMPLE_COUNT_4_BIT`이면 FS가 픽셀당 **4번** 실행된다. 각 실행은 서로 다른 샘플 위치에서 계산되므로, 텍스처의 서브픽셀 디테일까지 샘플링되어 **셰이더 기반 안티앨리어싱**이 적용된다.

**SSAA와 동일한 이유:**
- 일반 SSAA는 내부 해상도를 2x/4x로 높여 렌더링한 후 다운샘플링
- Sample Shading은 같은 일을 하지만, 래스터화 해상도는 그대로 두고 FS만 여러 번 실행
- 결과적으로 **픽셀 내부의 서브픽셀 위치에서 셰이딩**하여, 알파 테스트나 텍스처 패턴의 aliasing도 줄여줌

### 7.2. 성능 손실

Sample Shading의 가장 큰 단점은 **FS 실행 횟수가 샘플 수만큼 증가**한다는 점이다.

```
MSAA only:  FS = 1회/픽셀  → 성능 저하 거의 없음 (기하만)
SSAA 2x:    FS = 2회/픽셀  → 셰이더 부하 2배
SSAA 4x:    FS = 4회/픽셀  → 셰이더 부하 4배
SSAA 8x:    FS = 8회/픽셀  → 셰이더 부하 8배
```

특히:
- **픽셀 셰이더가 무거울수록 타격이 큼** (디퍼드 셰이딩, PBR 등)
- 메모리 대역폭도 증가 (GBuffer 쓰기가 N배)
- 전성비 관점에서는 차라리 해상도를 낮추고 TAA를 쓰는 편이 나을 수 있음

---

---

## 8. Depth/Stencil State

```c
VkPipelineDepthStencilStateCreateInfo dsCI{};
dsCI.depthTestEnable = VK_TRUE;
dsCI.depthWriteEnable = VK_TRUE;
dsCI.depthCompareOp = VK_COMPARE_OP_LESS;     // 깊이 비교 연산
dsCI.depthBoundsTestEnable = VK_FALSE;
dsCI.stencilTestEnable = VK_FALSE;

// 스텐실 프론트/백 별도 설정
dsCI.front.failOp = VK_STENCIL_OP_KEEP;
dsCI.front.passOp = VK_STENCIL_OP_REPLACE;
dsCI.front.compareOp = VK_COMPARE_OP_ALWAYS;
dsCI.front.reference = 1;
dsCI.front.compareMask = 0xff;
dsCI.front.writeMask = 0xff;
// back은 front와 동일한 내용
dsCI.back = dsCI.front;
```

스텐실이 있는 경우: `stencilTestEnable = VK_TRUE`, 그리고 프론트/백 각각에 대해 `failOp`, `passOp`, `depthFailOp`, `compareOp`, `reference`, `compareMask`, `writeMask`를 지정한다.

---

---

## 9. Color Blend State

Color Blend는 **새로 그린 색상과 기존 색상을 어떻게 섞을지** 결정한다.

```c
// 각 attachment별 blend 설정
VkPipelineColorBlendAttachmentState blendAttachments[2] = {};

// Attachment 0: 일반 blend (alpha blending)
blendAttachments[0].blendEnable = VK_TRUE;
blendAttachments[0].srcColorBlendFactor = VK_BLEND_FACTOR_SRC_ALPHA;
blendAttachments[0].dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
blendAttachments[0].colorBlendOp = VK_BLEND_OP_ADD;
blendAttachments[0].srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
blendAttachments[0].dstAlphaBlendFactor = VK_BLEND_FACTOR_ZERO;
blendAttachments[0].alphaBlendOp = VK_BLEND_OP_ADD;
blendAttachments[0].colorWriteMask = VK_COLOR_COMPONENT_R_BIT
                                   | VK_COLOR_COMPONENT_G_BIT
                                   | VK_COLOR_COMPONENT_B_BIT
                                   | VK_COLOR_COMPONENT_A_BIT;

// Attachment 1: 덧셈 blend (additive)
blendAttachments[1].blendEnable = VK_TRUE;
blendAttachments[1].srcColorBlendFactor = VK_BLEND_FACTOR_ONE;
blendAttachments[1].dstColorBlendFactor = VK_BLEND_FACTOR_ONE;
blendAttachments[1].colorBlendOp = VK_BLEND_OP_ADD;
blendAttachments[1].colorWriteMask = 0xF;

VkPipelineColorBlendStateCreateInfo cbCI{};
cbCI.logicOpEnable = VK_FALSE;
cbCI.logicOp = VK_LOGIC_OP_COPY;
cbCI.attachmentCount = 2;
cbCI.pAttachments = blendAttachments;
cbCI.blendConstants[0] = 1.0f;
cbCI.blendConstants[1] = 1.0f;
cbCI.blendConstants[2] = 1.0f;
cbCI.blendConstants[3] = 1.0f;
```

**Blend 방정식:**
```
finalColor.rgb = (srcColorBlendFactor × srcColor) colorBlendOp (dstColorBlendFactor × dstColor)
finalColor.a   = (srcAlphaBlendFactor × srcAlpha) alphaBlendOp (dstAlphaBlendFactor × dstAlpha)
```

**LogicOp:** `VK_TRUE`면 블렌딩 대신 비트 논리 연산 (`VK_LOGIC_OP_COPY`, `VK_LOGIC_OP_XOR` 등). 논리 연산은 Vulkan 1.1+ `VK_EXT_shader_stencil_export` 같은 특수 상황에서 사용.

`colorWriteMask`로 각 채널별 쓰기 허용/금지를 제어할 수 있다.

---

---

## 10. Dynamic State

파이프라인을 만들 때 설정을 고정하면, 나중에 바꿀 수 없다. **Dynamic State**로 선언하면 드로우 중에 값을 바꿀 수 있다.

```c
VkDynamicState dynamicStates[] = {
    VK_DYNAMIC_STATE_VIEWPORT,
    VK_DYNAMIC_STATE_SCISSOR,
    VK_DYNAMIC_STATE_LINE_WIDTH,
    VK_DYNAMIC_STATE_DEPTH_BIAS,
    VK_DYNAMIC_STATE_BLEND_CONSTANTS,
    VK_DYNAMIC_STATE_DEPTH_BOUNDS,
    VK_DYNAMIC_STATE_STENCIL_COMPARE_MASK,
    VK_DYNAMIC_STATE_STENCIL_WRITE_MASK,
    VK_DYNAMIC_STATE_STENCIL_REFERENCE,
};

VkPipelineDynamicStateCreateInfo dynCI{};
dynCI.dynamicStateCount = 9;
dynCI.pDynamicStates = dynamicStates;
```

동적 상태로 만들면 파이프라인 생성 시 해당 포인터를 `NULL`로 비워둘 수 있고, 드로우 전에 `vkCmdSet*` 명령으로 값을 설정한다.

`VK_EXT_extended_dynamic_state` (Vulkan 1.3 core)와 `VK_EXT_extended_dynamic_state3`가 추가되면서, **거의 모든 상태를 동적으로 설정**할 수 있게 되었다. 예를 들어 `VK_DYNAMIC_STATE_VERTEX_INPUT_EXT`를 사용하면 `VkPipelineVertexInputStateCreateInfo`조차 파이프라인에서 생략 가능하다.

---

---

## 11. Shader Stages

셰이더 모듈을 `VkShaderModule`로 로드하고, 각 단계를 `VkPipelineShaderStageCreateInfo`로 파이프라인에 연결한다.

```c
// 셰이더 모듈 생성
VkShaderModule vsModule, fsModule;
vkCreateShaderModule(device, &moduleCI, nullptr, &vsModule);
vkCreateShaderModule(device, &moduleCI, nullptr, &fsModule);

// 스테이지 배열
VkPipelineShaderStageCreateInfo stages[2] = {};
stages[0].stage = VK_SHADER_STAGE_VERTEX_BIT;
stages[0].module = vsModule;
stages[0].pName = "main";  // entry point

// Specialization Constants (파이프라인 생성 시 셰이더 상수 오버라이드)
VkSpecializationMapEntry specEntry{};
specEntry.constantID = 0;
specEntry.offset = 0;
specEntry.size = sizeof(int);
int specData = 256;
VkSpecializationInfo specInfo{};
specInfo.mapEntryCount = 1;
specInfo.pMapEntries = &specEntry;
specInfo.dataSize = sizeof(int);
specInfo.pData = &specData;

stages[1].stage = VK_SHADER_STAGE_FRAGMENT_BIT;
stages[1].module = fsModule;
stages[1].pName = "main";
stages[1].pSpecializationInfo = &specInfo; // 선택사항
```

**Specialization Constants:** 셰이더 컴파일 타임 상수값을 파이프라인 생성 시점에 결정할 수 있다. 같은 SPIR-V로 여러 파이프라인 배리언트를 만들 때 유용하다.

```glsl
// GLSL 셔터에서
layout(constant_id = 0) const int MAX_LIGHTS = 128;
void main() {
    for (int i = 0; i < MAX_LIGHTS; i++) { ... }
}
```

---

---

## 12. Pipeline Cache

파이프라인 생성은 무거운 연산이다. `VkPipelineCache`로 결과를 캐싱할 수 있다.

```c
VkPipelineCacheCreateInfo cacheCI{};
VkPipelineCache pipelineCache;
vkCreatePipelineCache(device, &cacheCI, nullptr, &pipelineCache);

// 생성 시 cache 전달
vkCreateGraphicsPipelines(device, pipelineCache, 1, &pipelineCI, nullptr, &pipeline);

// 다음 실행을 위해 cache 데이터를 파일로 저장
size_t dataSize;
vkGetPipelineCacheData(device, pipelineCache, &dataSize, nullptr);
void* data = malloc(dataSize);
vkGetPipelineCacheData(device, pipelineCache, &dataSize, data);
// file write...
```

---

---

## 13. 전체 파이프라인 생성 예제

```c
VkGraphicsPipelineCreateInfo pipelineCI{};
pipelineCI.sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO;
pipelineCI.stageCount = 2;
pipelineCI.pStages = stages;
pipelineCI.pVertexInputState = &vertexInputCI;
pipelineCI.pInputAssemblyState = &iaCI;
pipelineCI.pTessellationState = nullptr;  // 사용 안할 때
pipelineCI.pViewportState = &vpCI;
pipelineCI.pRasterizationState = &rsCI;
pipelineCI.pMultisampleState = &msCI;
pipelineCI.pDepthStencilState = &dsCI;
pipelineCI.pColorBlendState = &cbCI;
pipelineCI.pDynamicState = &dynCI;
pipelineCI.layout = pipelineLayout;
pipelineCI.renderPass = renderPass;
pipelineCI.subpass = 0;

VkPipeline pipeline;
vkCreateGraphicsPipelines(device, pipelineCache, 1, &pipelineCI, nullptr, &pipeline);
```

---

---

## 15. Dynamic Rendering과 Graphics Pipeline (Vulkan 1.3)

Dynamic Rendering(`vkCmdBeginRendering`)을 사용할 때는 `renderPass`와 `subpass` 대신 `VkPipelineRenderingCreateInfo`를 `VkGraphicsPipelineCreateInfo::pNext`에 체인한다.

```c
VkPipelineRenderingCreateInfo renderingCI{};
renderingCI.sType = VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO;
renderingCI.colorAttachmentCount = 1;
renderingCI.pColorAttachmentFormats = &colorFormat;
renderingCI.depthAttachmentFormat = VK_FORMAT_D32_SFLOAT;
renderingCI.stencilAttachmentFormat = VK_FORMAT_UNDEFINED;

VkGraphicsPipelineCreateInfo pipelineCI{};
pipelineCI.pNext = &renderingCI;  // ← 대신 renderPass = VK_NULL_HANDLE
pipelineCI.renderPass = VK_NULL_HANDLE;
pipelineCI.subpass = 0;
```

Dynamic Rendering에서는 VkFormat만 일치하면 render pass 오브젝트를 미리 만들 필요가 없어서 코드가 간결해진다.

---
