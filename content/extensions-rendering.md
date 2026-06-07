---
title: 확장기능 — 렌더링
slug: extensions-rendering
---

## 7. VK_KHR_maintenance5 — 파이프라인/렌더링 개선

> **Vulkan 1.4 코어 승격 | Roadmap 2024 필수**

### 왜 필수인가

- `VkPipelineCreateFlags2` (64비트 파이프라인 플래그)
- `VkBufferUsageFlags2` (64비트 버퍼 사용 플래그)
- 파이프라인 생성 시 `VkShaderModule` 없이 SPIR-V 직접 전달 가능
- `vkGetDeviceImageSubresourceLayout` — 이미지 생성 없이 레이아웃 쿼리
- 이미지 타입 간 복사 허용 (1D↔2D↔3D)
- `VK_REMAINING_ARRAY_LAYERS`를 서브리소스 레이어에 사용 가능

### 의존성

- Vulkan 1.1 + `VK_KHR_dynamic_rendering` 또는 Vulkan 1.3

### 사용 방법

```c
// 1. 기능 활성화
VkPhysicalDeviceMaintenance5FeaturesKHR maintenance5Features = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_5_FEATURES_KHR,
    .maintenance5 = VK_TRUE,
};

// 2. 파이프라인 생성 시 SPIR-V 직접 전달 (ShaderModule 불필요)
VkShaderModuleCreateInfo shaderModuleCI = {
    .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
    .codeSize = spirvSize,
    .pCode = spirvCode,
};

VkPipelineShaderStageCreateInfo stageInfo = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
    .pNext = &shaderModuleCI,  // ← ShaderModule 객체 생성 없이 직접 연결!
    .stage = VK_SHADER_STAGE_VERTEX_BIT,
    .pName = "main",
};

// 3. 64비트 버퍼 사용 플래그
VkBufferUsageFlags2CreateInfo bufferUsage2 = {
    .sType = VK_STRUCTURE_TYPE_BUFFER_USAGE_FLAGS_2_CREATE_INFO,
    .usage = VK_BUFFER_USAGE_2_SHADER_DEVICE_ADDRESS_BIT_KHR
           | VK_BUFFER_USAGE_2_STORAGE_BUFFER_BIT_KHR,
};
```

---

---

## 8. VK_EXT_mesh_shader — 메시 셰이딩

> **차세대 지오메트리 파이프라인 | NVIDIA Ada+, AMD RDNA3+, Intel Arc+**

### 왜 필수인가

- **Task Shader** + **Mesh Shader**로 기존 정점 파이프라인 대체
- 정점 페치, VS, TS, GS, PA를 **프로그래머블**하게 통합
- GPU 내부에서 지오메트리 컬링/생성/변형
- Nanite (UE5) 등의 마이크로나이프라이드 렌더링 핵심
- `vkCmdDrawMeshTasksEXT` 한 번으로 지오메트리 전체 처리

### 의존성

- `VK_KHR_spirv_1_4` 또는 Vulkan 1.2

### 핵심 구조체

```c
// 기능 쿼리
typedef struct VkPhysicalDeviceMeshShaderFeaturesEXT {
    VkStructureType    sType;
    void*              pNext;
    VkBool32           taskShader;       // Task Shader 지원
    VkBool32           meshShader;       // Mesh Shader 지원
    VkBool32           multiviewMeshShader;
    VkBool32           primitiveFragmentShadingRateMeshShader;
    VkBool32           meshShaderQueries;
} VkPhysicalDeviceMeshShaderFeaturesEXT;

// 간접 드로우 명령
typedef struct VkDrawMeshTasksIndirectCommandEXT {
    uint32_t    groupCountX;
    uint32_t    groupCountY;
    uint32_t    groupCountZ;
} VkDrawMeshTasksIndirectCommandEXT;
```

### 사용 방법

```c
// 1. 기능 활성화
VkPhysicalDeviceMeshShaderFeaturesEXT meshFeatures = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MESH_SHADER_FEATURES_EXT,
    .taskShader = VK_TRUE,
    .meshShader = VK_TRUE,
};

// 2. 파이프라인 생성 (Task + Mesh 스테이지)
VkPipelineShaderStageCreateInfo stages[] = {
    { .stage = VK_SHADER_STAGE_TASK_BIT_EXT, .pName = "main", /* ... */ },
    { .stage = VK_SHADER_STAGE_MESH_BIT_EXT, .pName = "main", /* ... */ },
};

// 3. 드로우 호출
vkCmdDrawMeshTasksEXT(
    commandBuffer,
    groupCountX,   // Task/Mesh 워크그룹 X
    groupCountY,   // Task/Mesh 워크그룹 Y
    groupCountZ    // Task/Mesh 워크그룹 Z
);

// 간접 드로우
vkCmdDrawMeshTasksIndirectEXT(
    commandBuffer,
    indirectBuffer,
    offset,
    drawCount,
    stride
);
```

### 파이프라인 비교

```
기존 파이프라인:
  Vertex Input → VS → [TS → TES] → [GS] → PA → RS → FS

메시 셰이딩:
  [Task Shader] → Mesh Shader → RS → FS
  (정점 페치 불필요, GPU 내부에서 지오메트리 생성)
```

### GLSL 메시 셰이더 예시

```glsl
// Task Shader
#version 460
#extension GL_EXT_mesh_shader : require
layout(local_size_x = 32) in;
taskPayloadSharedEXT uint payload;

void main() {
    // 컬링 로직 등
    uint visibleCount = cullCluster(gl_WorkGroupID.x);
    payload.visibleOffset = compact(gl_WorkGroupID.x, visibleCount);
    SetMeshOutputsEXT(visibleCount * 3, visibleCount);
    EmitMeshTasksEXT(visibleCount, 1, 1);
}

// Mesh Shader
#version 460
#extension GL_EXT_mesh_shader : require
layout(local_size_x = 32) in;
layout(max_vertices = 81, max_primitives = 126) out;
layout(triangles) out;
taskPayloadSharedEXT uint payload;

void main() {
    SetMeshOutputsEXT(3, 1);
    // 정점/프리미티브 출력
    gl_MeshVerticesEXT[0].gl_Position = /* ... */;
    gl_PrimitiveTriangleIndicesEXT[0] = uvec3(0, 1, 2);
}
```

---

---

## 9. VK_EXT_extended_dynamic_state — 확장 동적 상태

> **Vulkan 1.3 코어 승격 (부분) | 파이프라인 최소화에 필수**

### 왜 필수인가

- 파이프라인 객체 수를 획기적으로 감소
- Cull Mode, Front Face, Primitive Topology 등을 **동적으로 변경**
- **하나의 파이프라인**으로 대부분의 렌더링 상태 커버
- PSO 캐시 폭발 문제 해결

### 제공 동적 상태 (1.3 승격)

| 동적 상태 | 함수 |
|-----------|------|
| Cull Mode | `vkCmdSetCullMode` |
| Front Face | `vkCmdSetFrontFace` |
| Primitive Topology | `vkCmdSetPrimitiveTopology` |
| Viewport With Count | `vkCmdSetViewportWithCount` |
| Scissor With Count | `vkCmdSetScissorWithCount` |
| Depth Test Enable | `vkCmdSetDepthTestEnable` |
| Depth Write Enable | `vkCmdSetDepthWriteEnable` |
| Depth Compare Op | `vkCmdSetDepthCompareOp` |
| Depth Bounds Test Enable | `vkCmdSetDepthBoundsTestEnable` |
| Stencil Test Enable | `vkCmdSetStencilTestEnable` |
| Stencil Op | `vkCmdSetStencilOp` |
| Rasterizer Discard Enable | `vkCmdSetRasterizerDiscardEnable` |
| Depth Bias Enable | `vkCmdSetDepthBiasEnable` |
| Primitive Restart Enable | `vkCmdSetPrimitiveRestartEnable` |

### 사용 방법

```c
// 1. 파이프라인 생성 시 동적 상태로 선언
VkDynamicState dynamicStates[] = {
    VK_DYNAMIC_STATE_CULL_MODE,
    VK_DYNAMIC_STATE_FRONT_FACE,
    VK_DYNAMIC_STATE_PRIMITIVE_TOPOLOGY,
    VK_DYNAMIC_STATE_VIEWPORT_WITH_COUNT,
    VK_DYNAMIC_STATE_SCISSOR_WITH_COUNT,
    VK_DYNAMIC_STATE_DEPTH_TEST_ENABLE,
    VK_DYNAMIC_STATE_DEPTH_WRITE_ENABLE,
    VK_DYNAMIC_STATE_DEPTH_COMPARE_OP,
};

VkPipelineDynamicStateCreateInfo dynamicState = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_DYNAMIC_STATE_CREATE_INFO,
    .dynamicStateCount = sizeof(dynamicStates) / sizeof(dynamicStates[0]),
    .pDynamicStates = dynamicStates,
};

// 2. 렌더링 시 동적으로 설정
vkCmdSetCullMode(cmd, VK_CULL_MODE_BACK_BIT);
vkCmdSetFrontFace(cmd, VK_FRONT_FACE_COUNTER_CLOCKWISE);
vkCmdSetPrimitiveTopology(cmd, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST);
vkCmdSetDepthTestEnable(cmd, VK_TRUE);
vkCmdSetDepthWriteEnable(cmd, VK_TRUE);
vkCmdSetDepthCompareOp(cmd, VK_COMPARE_OP_GREATER);
```

---

---

## 10. VK_KHR_dynamic_rendering_local_read — 로컬 읽기

> **Vulkan 1.4 코어 승격 | Roadmap 2024 필수**

### 왜 필수인가

- 동적 렌더링에서 **서브패스 로컬 읽기** (Input Attachment) 기능 제공
- `VK_RENDERING_CONTENTS_INPUT_ATTACHMENT_READ_BIT_KHR` 플래그로 동일 렌더패스 내 텍스처 읽기
- 포스트프로세싱, 디퍼드 셰이딩의 라이트 패스에 필수
- 서브패스 없이 동적 렌더링만으로 서브패스급 성능 달성

### 의존성

- `VK_KHR_dynamic_rendering` 또는 Vulkan 1.3

### 사용 방법

```c
// 파이프라인 생성 시 입력 첨부 인덱스 지정
VkRenderingInputAttachmentIndexInfo inputInfo = {
    .sType = VK_STRUCTURE_TYPE_RENDERING_INPUT_ATTACHMENT_INDEX_INFO,
    .colorAttachmentCount = 2,
    .pColorAttachmentIndices = (uint32_t[]){ 0, 1 },  // 색상 첨부 0,1을 입력으로
    .pDepthAttachmentIndex = NULL,
    .pStencilAttachmentIndex = NULL,
};

// VkGraphicsPipelineCreateInfo::pNext에 연결
```

---

---

## 11. VK_KHR_load_store_op_none — Load/Store None

> **Vulkan 1.4 코어 승격 | Roadmap 2024 필수**

### 왜 필수인가

- `VK_ATTACHMENT_LOAD_OP_NONE` — 첨부 내용을 유지하면서 로드 동기화 생략
- `VK_ATTACHMENT_STORE_OP_NONE` — 첨부 내용을 보존하면서 스토어 동기화 생략
- 불필요한 메모리 트래픽 제거 (성능 직접 향상)
- 멀티패스 렌더링에서 이전 패스 결과를 그대로 사용할 때 유용

### 사용 방법

```c
VkRenderingAttachmentInfo attachment = {
    .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO,
    .imageView = gbufferAlbedo,
    .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
    .loadOp = VK_ATTACHMENT_LOAD_OP_NONE,    // ← 내용 유지, 로드 동기화 생략
    .storeOp = VK_ATTACHMENT_STORE_OP_NONE,   // ← 내용 보존, 스토어 동기화 생략
};
```

---

---

## 12. VK_KHR_fragment_shading_rate — 프래그먼트 셰이딩 레이트

> **Roadmap 2026 필수 | 가변 해상도 셰이딩**

### 왜 필수인가

- 화면 영역별로 **다른 셰이딩 레이트** 적용 (1x1, 1x2, 2x1, 2x2, 4x4...)
- 시선 집중 영역은 고해상도, 주변부는 저해상도
- Foveated Rendering, VRS (Variable Rate Shading) 구현
- 성능 대비 화질 최적화

### 셰이딩 레이트 종류

| 레이트 | 의미 | 성능 |
|--------|------|------|
| `1x1` | 모든 픽셀 셰이딩 | 최고 품질 |
| `1x2` | 2개 픽셀당 1번 셰이딩 | 2배 성능 |
| `2x1` | 2개 픽셀당 1번 셰이딩 | 2배 성능 |
| `2x2` | 4개 픽셀당 1번 셰이딩 | 4배 성능 |
| `4x4` | 16개 픽셀당 1번 셰이딩 | 16배 성능 |

### 사용 방법

```c
// 1. 기능 활성화
VkPhysicalDeviceFragmentShadingRateFeaturesKHR fsrFeatures = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_SHADING_RATE_FEATURES_KHR,
    .pipelineFragmentShadingRate = VK_TRUE,
    .primitiveFragmentShadingRate = VK_TRUE,
    .attachmentFragmentShadingRate = VK_TRUE,
};

// 2. 동적 상태로 설정
vkCmdSetFragmentShadingRateKHR(
    commandBuffer,
    &fragmentSize,        // VkExtent2D { 2, 2 } = 2x2 레이트
    combinerOps           // VkFragmentShadingRateCombinerOpKHR[2]
);

// 3. 또는 첨부 이미지로 설정 (화면 전체 VRS 맵)
VkRenderingFragmentShadingRateAttachmentInfoKHR fsrAttachment = {
    .sType = VK_STRUCTURE_TYPE_RENDERING_FRAGMENT_SHADING_RATE_ATTACHMENT_INFO_KHR,
    .imageView = vrsMapImageView,
    .texelSize = { 16, 16 },  // 각 texel이 16x16 픽셀 영역 제어
};

// 4. 프리미티브별 레이트 (GLSL)
// layout(primitive_shading_rate = 4) out int gl_ShadingRateEXT;
```

---
