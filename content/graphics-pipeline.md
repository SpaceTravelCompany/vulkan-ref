---
title: 그래픽스 파이프라인
slug: graphics-pipeline
---

## 소개

Vulkan의 그래픽스 파이프라인(`VkGraphicsPipeline`)은 셰이더 단계와 고정 함수 단계를 명시적으로 결합해 생성한다. `VkGraphicsPipelineCreateInfo` 구조체에 렌더링에 필요한 모든 상태를 한 번에 전달해야 하며, 런타임에 글로벌 상태를 빈번하게 변경하던 기존 API(OpenGL 등)와 구조적으로 다르다.

> [!NOTE]
> **파이프라인 상태 객체(PSO)의 도입 배경**  
> 과거 그래픽스 API는 드로우 호출 직전까지 개별 상태 변경을 허용했기 때문에, 드라이버가 매 드로우마다 상태 조합의 유효성을 검증하고 셰이더를 재컴파일해야 했다. Vulkan은 모든 렌더링 상태를 파이프라인 상태 객체(PSO)로 사전에 선언하도록 강제하여, 드라이버가 하드웨어 최적화 바이너리를 미리 생성하고 런타임 검증 부하를 최소화하도록 설계되었다.

### 주요 용어
- **고정 함수 유닛(FFU)**: 래스터화, 깊이·스텐실 테스트, 블렌딩 등 GPU 하드웨어에 고정된 연산 단계
- **프로그래머블 셰이더**: 버텍스, 테셀레이션, 지오메트리, 프래그먼트 등 개발자가 작성한 SPIR-V 코드가 실행되는 단계
- **파이프라인 상태 객체(PSO)**: 셰이더와 고정 함수 설정을 하나로 묶은 불변(Immutable) 객체

---

## 1. 파이프라인 구조

Vulkan 그래픽스 파이프라인은 정점 입력부터 최종 프레임버퍼 출력까지 프로그래머블 셰이더와 고정 함수 단계를 순차적으로 거친다.

```flowchart
flowchart TD
  A["Vertex Input Buffer"]
  B["vertex input (VB/IB → 속성) — VkPipelineVertexInputStateCreateInfo · 고정"]
  C["input assembly (정점 → 프리미티브) — VkPipelineInputAssemblyStateCreateInfo · 고정"]
  D["vertex shader — 프로그래머블"]
  E["tessellation (옵션) — VkPipelineTessellationStateCreateInfo · 고정"]
  F["control shader — 프로그래머블"]
  G["evaluation shader — 프로그래머블"]
  H["geometry shader (옵션) — 프로그래머블"]
  I["rasterization (정점 → 프래그먼트) — VkPipelineRasterizationStateCreateInfo · 고정"]
  J["cull mode, front face, depth bias, polygon mode"]
  K["multisampling (MSAA) — VkPipelineMultisampleStateCreateInfo · 고정"]
  L["depth/stencil — VkPipelineDepthStencilStateCreateInfo · 고정"]
  M["fragment shader — 프로그래머블"]
  N["color blending — VkPipelineColorBlendStateCreateInfo · 고정"]
  O["Framebuffer"]
  A --> B --> C --> D --> E --> F --> G --> H --> I --> J --> K --> L --> M --> N --> O
```

Vulkan 명세(10.4. Graphics Pipelines)는 이 상태들을 4개의 논리적 그룹으로 분류한다.

| 그룹 | 포함 상태 | 역할 |
|------|---------|------|
| **Vertex Input State** | VertexInput, InputAssembly | 정점 버퍼 메모리 바인딩 및 프리미티브 토폴로지 구성 |
| **Pre-rasterization Shader State** | VS, TCS, TES, GS, Tessellation, Viewport, Rasterization | 래스터화 이전 지오메트리 처리와 래스터화 방식 결정 |
| **Fragment Shader State** | Fragment Shader | 프래그먼트 셰이더 코드 및 인터페이스 |
| **Fragment Output State** | ColorBlend, DepthStencil, Multisample | 프래그먼트 테스트, 픽셀 블렌딩, MSAA, 최종 어테치먼트 출력 |

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

### 핵심 필드 설명
- **상태 구조체 포인터**: `pVertexInputState`, `pViewportState` 등은 특정 조건에서만 `NULL`로 지정할 수 있다. `pViewportState`는 `VK_EXT_extended_dynamic_state3` + `VK_DYNAMIC_STATE_VIEWPORT_WITH_COUNT`·`SCISSOR_WITH_COUNT` 동시 설정 시에만 NULL 가능하고, `pVertexInputState`는 `VK_DYNAMIC_STATE_VERTEX_INPUT_EXT` 활성화 시, `pRasterizationState`는 extended_dynamic_state3 + 8개 래스터화 동적 상태 전부가 필요하다. 단순히 `VK_DYNAMIC_STATE_VIEWPORT`만으로는 생략할 수 없다.
- `renderPass` 및 `subpass`: 파이프라인이 바인딩될 렌더 패스와 서브패스 인덱스를 지정한다. 파이프라인은 이 렌더 패스와 호환(compatible)되는 프레임버퍼 또는 동적 렌더링(Dynamic Rendering) 환경에서만 실행할 수 있다.
- `layout`: 셰이더가 접근할 디스크립터 세트 레이아웃과 푸시 상수 범위를 정의한 `VkPipelineLayout` 핸들이다.

---

## 3. Vertex Input State (정점 입력)

정점 버퍼의 메모리 레이아웃과 셰이더 입력 속성(`location`) 간의 연결 방식을 정의한다.

### 3.1. Vertex Input Binding (버퍼 → 정점 스트림)

정점 버퍼의 슬롯 번호와 정점 간의 메모리 간격을 설정한다.

```c
VkVertexInputBindingDescription bindings[2] = {};
bindings[0].binding = 0;                              // 바인딩 슬롯 0
bindings[0].stride = sizeof(Vertex);                  // 정점 1개당 바이트 크기
bindings[0].inputRate = VK_VERTEX_INPUT_RATE_VERTEX;  // 정점 단위 갱신

bindings[1].binding = 1;                              // 바인딩 슬롯 1
bindings[1].stride = sizeof(InstanceData);            // 인스턴스 1개당 바이트 크기
bindings[1].inputRate = VK_VERTEX_INPUT_RATE_INSTANCE;// 인스턴스 단위 갱신 (인스턴싱)
```

`inputRate`:
- `VK_VERTEX_INPUT_RATE_VERTEX`: 각 정점을 그릴 때마다 다음 데이터로 진행
- `VK_VERTEX_INPUT_RATE_INSTANCE`: 각 인스턴스를 그릴 때마다 다음 데이터로 진행

### 3.2. Vertex Input Attribute (버퍼 오프셋 → 셰이더 location)

버퍼 내부의 특정 필드를 셰이더의 `layout(location = N)` 변수에 매핑한다.

```c
VkVertexInputAttributeDescription attributes[3] = {};
attributes[0].location = 0;                           // 셰이더 layout(location = 0)
attributes[0].binding = 0;                            // 바인딩 슬롯 0 참조
attributes[0].format = VK_FORMAT_R32G32B32_SFLOAT;    // 32비트 부동소수점 3개 (vec3)
attributes[0].offset = offsetof(Vertex, pos);

attributes[1].location = 1;                           // layout(location = 1)
attributes[1].binding = 0;
attributes[1].format = VK_FORMAT_R32G32B32_SFLOAT;    // vec3 (법선)
attributes[1].offset = offsetof(Vertex, normal);

attributes[2].location = 2;                           // layout(location = 2)
attributes[2].binding = 1;                            // 바인딩 슬롯 1 (인스턴스 데이터)
attributes[2].format = VK_FORMAT_R32G32B32A32_SFLOAT; // vec4 (인스턴스 색상)
attributes[2].offset = offsetof(InstanceData, color);
```

**GLSL 버텍스 셰이더 대응:**
```glsl
layout(location = 0) in vec3 inPos;
layout(location = 1) in vec3 inNormal;
layout(location = 2) in vec4 inInstanceColor; // 인스턴스 속성
```

> [!IMPORTANT]
> `format`은 GPU가 버퍼 메모리에서 읽어 들일 형식을 지정한다. 셰이더에서 `vec3`로 받더라도 메모리에 16비트 반정밀도 부동소수점으로 저장되어 있다면 `VK_FORMAT_R16G16B16_SFLOAT`를 지정해야 정상적으로 변환된다. 64비트 컴포넌트(`dvec2`, `R64G64_SFLOAT` 등)는 **location 2개를 소비**하므로, 다음 속성의 location 번호가 자동으로 2만큼 건너뛴다.

### 3.3. Input Assembly (기본 도형 조립)

정점들을 어떠한 프리미티브 기하 형태로 묶을지 지정한다.

```c
VkPipelineInputAssemblyStateCreateInfo iaCI{};
iaCI.sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO;
iaCI.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;
iaCI.primitiveRestartEnable = VK_FALSE;
```

| 토폴로지 | 의미 |
|---------|------|
| `VK_PRIMITIVE_TOPOLOGY_POINT_LIST` | 독립된 점 목록 |
| `VK_PRIMITIVE_TOPOLOGY_LINE_LIST` / `LINE_STRIP` | 선 목록 또는 연결된 선 스트립 |
| `VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST` / `STRIP` / `FAN` | 삼각형 목록, 스트립, 팬 |
| `VK_PRIMITIVE_TOPOLOGY_*_WITH_ADJACENCY` | 인접 정점 정보를 포함하는 형태 (지오메트리 셰이더 전용) |
| `VK_PRIMITIVE_TOPOLOGY_PATCH_LIST` | 테셀레이션 제어점에 매핑되는 패치 형태 |

---

## 4. Tessellation State (테셀레이션)

테셀레이션을 활성화하려면 토폴로지를 `VK_PRIMITIVE_TOPOLOGY_PATCH_LIST`로 설정하고 `VkPipelineTessellationStateCreateInfo`를 지정한다.

```c
VkPipelineTessellationStateCreateInfo tessCI{};
tessCI.sType = VK_STRUCTURE_TYPE_PIPELINE_TESSELLATION_STATE_CREATE_INFO;
tessCI.patchControlPoints = 3; // 패치당 제어점 개수
```

셰이더 단계에서는 TCS(Tessellation Control Shader)와 TES(Tessellation Evaluation Shader)를 함께 파이프라인에 연결한다.

```glsl
// TCS: 패치 분할 수준(Tessellation Level) 결정
layout(vertices = 3) out;
void main() {
    gl_TessLevelOuter[0] = 4.0;
    gl_TessLevelOuter[1] = 4.0;
    gl_TessLevelOuter[2] = 4.0;
    gl_TessLevelInner[0] = 4.0;
}

// TES: 생성된 도메인 좌표를 바탕으로 정점 위치 산출
layout(triangles, equal_spacing, cw) in;
void main() {
    gl_Position = gl_in[0].gl_Position * gl_TessCoord.x
                + gl_in[1].gl_Position * gl_TessCoord.y
                + gl_in[2].gl_Position * gl_TessCoord.z;
}
```

---

## 5. Viewport State (뷰포트 및 시저)

정규화 디바이스 좌표(NDC)를 프레임버퍼 픽셀 좌표로 변환하는 뷰포트와 렌더링 영역을 제한하는 시저(Scissor) 사각형을 설정한다.

```c
VkViewport viewport{};
viewport.x = 0.0f;
viewport.y = 0.0f;
viewport.width = 1920.0f;
viewport.height = 1080.0f;
viewport.minDepth = 0.0f;
viewport.maxDepth = 1.0f;

VkRect2D scissor{};
scissor.offset = {0, 0};
scissor.extent = {1920, 1080};

VkPipelineViewportStateCreateInfo vpCI{};
vpCI.sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO;
vpCI.viewportCount = 1;
vpCI.pViewports = &viewport;
vpCI.scissorCount = 1;
vpCI.pScissors = &scissor;
```

> [!TIP]
> 화면 크기 변경 시 파이프라인을 재생성하지 않으려면 `VkPipelineDynamicStateCreateInfo`에 `VK_DYNAMIC_STATE_VIEWPORT`와 `VK_DYNAMIC_STATE_SCISSOR`를 등록한다. 이후 커맨드 버퍼 기록 시 `vkCmdSetViewport`와 `vkCmdSetScissor`를 호출하여 동적으로 값을 설정할 수 있다.

---

## 6. Rasterization State (래스터화)

기하학적 프리미티브를 화면 격자상의 프래그먼트로 변환하는 단계를 제어한다.

```c
VkPipelineRasterizationStateCreateInfo rsCI{};
rsCI.sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO;
rsCI.depthClampEnable = VK_FALSE;                  // 깊이 클램핑 (Near/Far 평면 밖 클램핑 여부)
rsCI.rasterizerDiscardEnable = VK_FALSE;           // VK_TRUE면 프래그먼트를 생성하지 않음
rsCI.polygonMode = VK_POLYGON_MODE_FILL;           // FILL, LINE, POINT
rsCI.cullMode = VK_CULL_MODE_BACK_BIT;             // 백페이스 컬링
rsCI.frontFace = VK_FRONT_FACE_COUNTER_CLOCKWISE;  // 반시계방향(CCW)을 전면으로 판정
rsCI.depthBiasEnable = VK_FALSE;
rsCI.depthBiasConstantFactor = 0.0f;   // 깊이 바이어스 상수 오프셋
rsCI.depthBiasClamp = 0.0f;            // 바이어스 클램핑 범위
rsCI.depthBiasSlopeFactor = 0.0f;      // 폴리곤 슬로프 기반 바이어스 계수
rsCI.lineWidth = 1.0f;
```

### 핵심 필드
- `rasterizerDiscardEnable`: `VK_TRUE`로 설정하면 래스터화 단계를 건너뛰고 프래그먼트를 생성하지 않는다. 변환 피드백이나 지오메트리 연산 결과만 기록하는 패스에서 사용하며, 이 경우 뷰포트, 멀티샘플, 깊이·스텐실, 컬러 블렌드 상태 포인터를 생략할 수 있다.
- `polygonMode`: 기본값은 `VK_POLYGON_MODE_FILL`이다. `LINE`(와이어프레임)이나 `POINT`를 사용하려면 `VkPhysicalDeviceFeatures::fillModeNonSolid` 피처를 활성화해야 한다.
- `depthClampEnable`: `VK_TRUE`로 설정하면 Near/Far 평면을 벗어난 프래그먼트를 폐기(Clip)하지 않고 [0, 1] 깊이 경계로 고정(Clamp)한다. 그림자 맵 렌더링 등에서 캡 누락을 방지할 때 유용하다.

---

## 7. Multisample State (MSAA)

멀티샘플링 안티앨리어싱(MSAA) 설정을 구성하여 기하 경계면의 계단 현상을 완화한다.

```c
VkPipelineMultisampleStateCreateInfo msCI{};
msCI.sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO;
msCI.rasterizationSamples = VK_SAMPLE_COUNT_4_BIT; // 픽셀당 샘플 수 (1, 2, 4, 8 등)
msCI.sampleShadingEnable = VK_FALSE;
msCI.minSampleShading = 1.0f;
msCI.pSampleMask = nullptr;
msCI.alphaToCoverageEnable = VK_FALSE;
msCI.alphaToOneEnable = VK_FALSE;
```

### 7.1. Sample Shading (샘플 셰이딩)

`sampleShadingEnable`을 `VK_TRUE`로 활성화하려면 `VkPhysicalDeviceFeatures::sampleRateShading` 피처가 필요하다(VUID-VkPipelineMultisampleStateCreateInfo-sampleShadingEnable-00784). 활성화 시 프래그먼트 셰이더를 픽셀 단위가 아닌 개별 서브픽셀 샘플 위치에서 실행한다. SSAA와 유사한 효과를 내지만, SSAA는 전체 렌더 타깃을 고해상도로 렌더링하는 것이고 Sample Shading은 MSAA 프레임버퍼 내에서 프래그먼트 실행 빈도만 높이는 점이 다르다.

```c
// Sample Shading 활성화 설정
msCI.rasterizationSamples = VK_SAMPLE_COUNT_4_BIT;
msCI.sampleShadingEnable = VK_TRUE;
msCI.minSampleShading = 1.0f; // 1.0f: 모든 샘플에 대해 프래그먼트 셰이더 개별 실행
```

| 모드 | 프래그먼트 셰이더 실행 주기 | 계산 위치 | 적용 효과 |
|------|------------------------|----------|----------|
| **MSAA 기본** | 픽셀당 1회 | 픽셀 중심점 | 기하 경계면만 안티앨리어싱 |
| **Sample Shading (0.25)** | 픽셀당 1~4회 가변 | 서브픽셀 샘플 위치 | 중간 수준 품질 |
| **Sample Shading (1.0)** | 샘플 수만큼 실행 (4회) | 각 서브픽셀 샘플 위치 | 텍스처 앨리어싱 완화 (완전한 SSAA) |

### 7.2. 성능 고려사항
Sample Shading은 프래그먼트 셰이더 호출 횟수가 샘플 배수만큼 선형적으로 증가한다.
- 4x 샘플 셰이딩 사용 시 픽셀 셰이더 연산 부하가 최대 4배까지 증가한다.
- PBR이나 디퍼드 셰이딩처럼 프래그먼트 연산 비용이 높은 파이프라인에서는 성능 저하가 크므로, 모바일이나 저전력 환경에서는 TAA 등 대체 기법을 검토해야 한다.

---

## 8. Depth/Stencil State (깊이 및 스텐실)

프래그먼트의 깊이 비교 연산과 스텐실 버퍼 마스킹 규칙을 설정한다.

```c
VkPipelineDepthStencilStateCreateInfo dsCI{};
dsCI.sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO;
dsCI.depthTestEnable = VK_TRUE;               // 깊이 테스트 활성화
dsCI.depthWriteEnable = VK_TRUE;              // 깊이 버퍼 쓰기 활성화
dsCI.depthCompareOp = VK_COMPARE_OP_LESS;     // 기존 값보다 작을 때 통과
dsCI.depthBoundsTestEnable = VK_FALSE;
dsCI.stencilTestEnable = VK_FALSE;

// 전면 및 후면 스텐실 연산 설정
dsCI.front.failOp = VK_STENCIL_OP_KEEP;
dsCI.front.passOp = VK_STENCIL_OP_REPLACE;
dsCI.front.depthFailOp = VK_STENCIL_OP_KEEP;
dsCI.front.compareOp = VK_COMPARE_OP_ALWAYS;
dsCI.front.compareMask = 0xFF;
dsCI.front.writeMask = 0xFF;
dsCI.front.reference = 1;
dsCI.back = dsCI.front;
```

---

## 9. Color Blend State (색상 혼합)

새로 생성된 프래그먼트 색상과 기존 컬러 어태치먼트의 픽셀 색상을 합성하는 방식을 정의한다.

```c
VkPipelineColorBlendAttachmentState blendAttachments[1] = {};
blendAttachments[0].blendEnable = VK_TRUE;

// 색상 채널 블렌딩: (srcColor * srcAlpha) + (dstColor * (1 - srcAlpha))
blendAttachments[0].srcColorBlendFactor = VK_BLEND_FACTOR_SRC_ALPHA;
blendAttachments[0].dstColorBlendFactor = VK_BLEND_FACTOR_ONE_MINUS_SRC_ALPHA;
blendAttachments[0].colorBlendOp = VK_BLEND_OP_ADD;

// 알파 채널 블렌딩
blendAttachments[0].srcAlphaBlendFactor = VK_BLEND_FACTOR_ONE;
blendAttachments[0].dstAlphaBlendFactor = VK_BLEND_FACTOR_ZERO;
blendAttachments[0].alphaBlendOp = VK_BLEND_OP_ADD;

blendAttachments[0].colorWriteMask = VK_COLOR_COMPONENT_R_BIT
                                   | VK_COLOR_COMPONENT_G_BIT
                                   | VK_COLOR_COMPONENT_B_BIT
                                   | VK_COLOR_COMPONENT_A_BIT;

VkPipelineColorBlendStateCreateInfo cbCI{};
cbCI.sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO;
cbCI.logicOpEnable = VK_FALSE;
cbCI.logicOp = VK_LOGIC_OP_COPY;
cbCI.attachmentCount = 1;
cbCI.pAttachments = blendAttachments;
```

### 블렌딩 공식
$$\text{finalColor.rgb} = (\text{srcColorBlendFactor} \times \text{srcColor}) \;\text{colorBlendOp}\; (\text{dstColorBlendFactor} \times \text{dstColor})$$
$$\text{finalColor.a} = (\text{srcAlphaBlendFactor} \times \text{srcAlpha}) \;\text{alphaBlendOp}\; (\text{dstAlphaBlendFactor} \times \text{dstAlpha})$$

> [!NOTE]
> **LogicOp(논리 연산)**  
> `logicOpEnable`을 `VK_TRUE`로 설정하면 비트 논리 연산(`VK_LOGIC_OP_COPY`, `VK_LOGIC_OP_XOR` 등 16종)을 컬러 어테치먼트에 적용한다. 논리 연산은 부호 있거나 없는 정수형 또는 정규화 정수형 포맷에서만 동작하며, 부동소수점·sRGB 포맷에서는 값이 그대로 통과한다. `blendEnable`과 `logicOpEnable`을 동시에 켜면 블렌딩은 무시되고 논리 연산만 적용된다(오류 아님).

---

## 10. Dynamic State (동적 상태)

파이프라인 생성 시 설정을 고정하지 않고 커맨드 버퍼 기록 시점에 동적으로 덮어쓸 상태들을 지정한다.

```c
VkDynamicState dynamicStates[] = {
    VK_DYNAMIC_STATE_VIEWPORT,
    VK_DYNAMIC_STATE_SCISSOR,
    VK_DYNAMIC_STATE_LINE_WIDTH,
    VK_DYNAMIC_STATE_DEPTH_BIAS,
    VK_DYNAMIC_STATE_BLEND_CONSTANTS,
    VK_DYNAMIC_STATE_STENCIL_REFERENCE,
};

VkPipelineDynamicStateCreateInfo dynCI{};
dynCI.sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO;
dynCI.dynamicStateCount = sizeof(dynamicStates) / sizeof(dynamicStates[0]);
dynCI.pDynamicStates = dynamicStates;
```

동적 상태로 등록한 항목은 `vkCmdSetViewport`, `vkCmdSetScissor` 등의 명령으로 드로우 전에 호출하여 변경할 수 있다. Vulkan 1.3 코어에 포함된 확장(`VK_EXT_extended_dynamic_state` 등)을 활용하면 래스터라이저, 깊이 테스트, 정점 입력 바인딩까지 거의 모든 상태를 런타임에 동적으로 변경할 수 있다.

---

## 11. Shader Stages (셰이더 스테이지)

SPIR-V 셰이더 모듈을 연결하고 진입점(Entry Point)과 특수화 상수(Specialization Constants)를 설정한다.

```c
VkPipelineShaderStageCreateInfo stages[2] = {};

// 버텍스 셰이더 스테이지
stages[0].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
stages[0].stage = VK_SHADER_STAGE_VERTEX_BIT;
stages[0].module = vsModule;
stages[0].pName = "main";

// 특수화 상수: 컴파일 시점 상수를 파이프라인 생성 시점에 주입
VkSpecializationMapEntry specEntry{};
specEntry.constantID = 0;
specEntry.offset = 0;
specEntry.size = sizeof(int);

int maxLightsValue = 128;
VkSpecializationInfo specInfo{};
specInfo.mapEntryCount = 1;
specInfo.pMapEntries = &specEntry;
specInfo.dataSize = sizeof(int);
specInfo.pData = &maxLightsValue;

// 프래그먼트 셰이더 스테이지
stages[1].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
stages[1].stage = VK_SHADER_STAGE_FRAGMENT_BIT;
stages[1].module = fsModule;
stages[1].pName = "main";
stages[1].pSpecializationInfo = &specInfo;
```

특수화 상수를 사용하면 동일한 SPIR-V 바이너리를 유지하면서 루프 언롤링, 분기 제거 등 하드웨어 최적화가 적용된 다수의 특화 파이프라인 변형을 효율적으로 컴파일할 수 있다.

---

## 12. Pipeline Cache (파이프라인 캐시)

파이프라인 컴파일은 많은 CPU 시간을 소모한다. `VkPipelineCache`를 전달하면 컴파일 결과를 캐싱하고 디스크에 직렬화하여 다음 실행 시 재활용할 수 있다.

```c
VkPipelineCacheCreateInfo cacheCI{};
cacheCI.sType = VK_STRUCTURE_TYPE_PIPELINE_CACHE_CREATE_INFO;

VkPipelineCache pipelineCache;
vkCreatePipelineCache(device, &cacheCI, nullptr, &pipelineCache);

// 파이프라인 생성 시 캐시 객체 전달
vkCreateGraphicsPipelines(device, pipelineCache, 1, &pipelineCI, nullptr, &pipeline);

// 다음 실행을 위해 캐시 데이터를 추출하여 파일로 저장
size_t dataSize = 0;
vkGetPipelineCacheData(device, pipelineCache, &dataSize, nullptr);
std::vector<char> cacheData(dataSize);
vkGetPipelineCacheData(device, pipelineCache, &dataSize, cacheData.data());
```

---

## 13. 전체 파이프라인 생성 예제

```c
VkGraphicsPipelineCreateInfo pipelineCI{};
pipelineCI.sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO;
pipelineCI.stageCount = 2;
pipelineCI.pStages = stages;
pipelineCI.pVertexInputState = &vertexInputCI;
pipelineCI.pInputAssemblyState = &iaCI;
pipelineCI.pTessellationState = nullptr; // 테셀레이션 미사용 시 NULL
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
VkResult result = vkCreateGraphicsPipelines(device, pipelineCache, 1, &pipelineCI, nullptr, &pipeline);
if (result != VK_SUCCESS) {
    // 파이프라인 생성 실패 예외 처리
}
```
