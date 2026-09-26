---
title: 렌더링 확장
slug: extensions-rendering
---

## 7. VK_KHR_maintenance5 — 파이프라인 및 렌더링 개선

> **Vulkan 1.4 코어 승격 | Roadmap 2024 필수**

### 용도

- `VkPipelineCreateFlags2KHR` 지원 (64비트 파이프라인 생성 플래그 확장)
- `VkBufferUsageFlags2KHR` 지원 (64비트 버퍼 사용 용도 플래그 확장)
- 파이프라인 생성 시 `VkShaderModule` 객체 생성 없이 SPIR-V 바이너리를 `pNext`로 직접 전달 가능
- `vkGetDeviceImageSubresourceLayoutKHR`: 실제 `VkImage` 객체를 생성하지 않고도 서브리소스 메모리 레이아웃 질의 가능
- 서로 다른 이미지 차원 간(`1D` ↔ `2D` ↔ `3D`) 데이터 복사 허용
- 서브리소스 레이어 구조체에서 `VK_REMAINING_ARRAY_LAYERS` 상수 사용 가능

### 의존성

- Vulkan 1.1 + `VK_KHR_dynamic_rendering` (또는 Vulkan 1.3 이상)

### 사용 방법

```c
// 1. 기능 활성화
VkPhysicalDeviceMaintenance5FeaturesKHR maintenance5Features = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_5_FEATURES_KHR,
    .maintenance5 = VK_TRUE,
};

// 2. 파이프라인 생성 시 SPIR-V 바이너리 직접 전달 (VkShaderModule 생성 불필요)
VkShaderModuleCreateInfo shaderModuleCI = {
    .sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO,
    .codeSize = spirvSize,
    .pCode = spirvCode,
};

VkPipelineShaderStageCreateInfo stageInfo = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
    .pNext = &shaderModuleCI,  // VkShaderModule 핸들 대신 CreateInfo를 직접 체인에 연결
    .stage = VK_SHADER_STAGE_VERTEX_BIT,
    .pName = "main",
};

// 3. 64비트 버퍼 사용 플래그 지정
VkBufferUsageFlags2CreateInfo bufferUsage2 = {
    .sType = VK_STRUCTURE_TYPE_BUFFER_USAGE_FLAGS_2_CREATE_INFO,
    .usage = VK_BUFFER_USAGE_2_SHADER_DEVICE_ADDRESS_BIT_KHR
           | VK_BUFFER_USAGE_2_STORAGE_BUFFER_BIT_KHR,
};
```

---

## 8. VK_EXT_mesh_shader — 메시 셰이딩

> **차세대 지오메트리 파이프라인 | NVIDIA Turing+, AMD RDNA3+, Intel Arc+**

### 용도

- 태스크 셰이더(Task Shader)와 메시 셰이더(Mesh Shader)의 2단계 구조로 기존 고정 기능 기반 정점 파이프라인 대체
- 고정 정점 페치(Vertex Fetch), 정점 셰이더, 테셀레이션, 지오메트리 셰이더, 프리미티브 어셈블리를 소프트웨어적으로 통합 제어
- 메시렛(Meshlet) 단위로 GPU 내부에서 컬링, LOD 선택, 지오메트리 증폭을 직접 수행
- Unreal Engine 5의 Nanite 등 클러스터 기반 가상화 지오메트리(Virtualized Geometry) 렌더링의 핵심 기반
- `vkCmdDrawMeshTasksEXT` 호출 한 번으로 지오메트리 생성과 래스터화를 일괄 처리

### 의존성

- `VK_KHR_spirv_1_4` (또는 Vulkan 1.2 이상)

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

// 간접 드로우 명령 구조체
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

// 2. 파이프라인 생성 (Task + Mesh 스테이지 구성)
VkPipelineShaderStageCreateInfo stages[] = {
    { .stage = VK_SHADER_STAGE_TASK_BIT_EXT, .pName = "main", /* ... */ },
    { .stage = VK_SHADER_STAGE_MESH_BIT_EXT, .pName = "main", /* ... */ },
};

// 3. 직접 드로우 호출
vkCmdDrawMeshTasksEXT(
    commandBuffer,
    groupCountX,   // Task 또는 Mesh 워크그룹 X 크기
    groupCountY,   // Task 또는 Mesh 워크그룹 Y 크기
    groupCountZ    // Task 또는 Mesh 워크그룹 Z 크기
);

// 4. 간접 드로우 호출
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
기존 고정 정점 파이프라인:
  Vertex Input → VS → [TS → TES] → [GS] → PA → RS → FS

메시 셰이딩 파이프라인:
  [Task Shader] → Mesh Shader → RS → FS
  (고정 정점 페치 생략, 메시렛 단위 컴퓨트 셰이더 방식으로 지오메트리 생성)
```

### GLSL 메시 셰이더 예시

```glsl
// Task Shader
#version 460
#extension GL_EXT_mesh_shader : require
layout(local_size_x = 32) in;

// 태스크 페이로드는 단일 구조체로 선언 (TaskPayloadWorkgroupEXT 스토리지 클래스)
taskPayloadSharedEXT struct TaskPayload {
    uint visibleMeshletCount;
} payload;

void main() {
    // 바운딩 구 컬링 등으로 유효 메시렛 개수 산출
    uint count = cullCluster(gl_WorkGroupID.x);
    payload.visibleMeshletCount = count;

    // EmitMeshTasksEXT(uint groupCountX, uint groupCountY, uint groupCountZ)
    // 후속 실행할 메시 셰이더의 3차원 워크그룹 개수를 발행 (count를 X 차원에 매핑)
    EmitMeshTasksEXT(count, 1, 1);
}

// Mesh Shader
#version 460
#extension GL_EXT_mesh_shader : require
layout(local_size_x = 32) in;
layout(max_vertices = 81, max_primitives = 126) out;
layout(triangles) out;

// Task Shader에서 전달받은 페이로드 선언
taskPayloadSharedEXT struct TaskPayload {
    uint visibleMeshletCount;
} payload;

void main() {
    // 출력 정점 수와 기본 도형(Primitive) 수 선언
    SetMeshOutputsEXT(3, 1);

    // 정점 및 프리미티브 인덱스 데이터 출력
    gl_MeshVerticesEXT[0].gl_Position = vec4(0.0, 0.5, 0.0, 1.0);
    gl_MeshVerticesEXT[1].gl_Position = vec4(-0.5, -0.5, 0.0, 1.0);
    gl_MeshVerticesEXT[2].gl_Position = vec4(0.5, -0.5, 0.0, 1.0);
    gl_PrimitiveTriangleIndicesEXT[0] = uvec3(0, 1, 2);
}
```

---

## 9. VK_EXT_extended_dynamic_state — 확장 동적 상태

> **Vulkan 1.3 코어 승격 (부분) | 파이프라인 최소화 필수**

### 용도

- 사전에 구워두어야 했던 파이프라인 상태 객체(PSO)의 생성 개수를 획기적으로 절감
- 컬 모드(Cull Mode), 전면 방향(Front Face), 기본 토폴로지(Primitive Topology) 등을 커맨드 버퍼 기록 시점에 동적으로 변경
- 단일 파이프라인으로 다양한 렌더링 상태 조합을 처리하여 파이프라인 바인딩 오버헤드 최소화
- 런타임 셰이더 컴파일 지연 및 PSO 캐시 폭발(State Explosion) 문제 완화

### 제공 동적 상태 (Vulkan 1.3 승격 항목)

| 동적 상태 | 설정 함수 |
|-----------|-----------|
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
// 1. 파이프라인 생성 시 동적 상태 배열 등록
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

// 2. 렌더링 시 커맨드 버퍼에서 동적 설정
vkCmdSetCullMode(cmd, VK_CULL_MODE_BACK_BIT);
vkCmdSetFrontFace(cmd, VK_FRONT_FACE_COUNTER_CLOCKWISE);
vkCmdSetPrimitiveTopology(cmd, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST);
vkCmdSetDepthTestEnable(cmd, VK_TRUE);
vkCmdSetDepthWriteEnable(cmd, VK_TRUE);
vkCmdSetDepthCompareOp(cmd, VK_COMPARE_OP_GREATER);
```

---

## 10. VK_KHR_dynamic_rendering_local_read — 동적 렌더링 로컬 읽기

> **Vulkan 1.4 코어 승격 | Roadmap 2024 필수**

### 용도

- 동적 렌더링에서 프래그먼트 셰이더가 같은 렌더 패스 내 다른 색상 첨부를 입력 첨부처럼 읽을 수 있게 한다
- `VK_IMAGE_LAYOUT_RENDERING_LOCAL_READ_KHR` 레이아웃과 `VkRenderingInputAttachmentIndexInfoKHR`(또는 `vkCmdSetRenderingInputAttachmentIndicesKHR`)으로 온칩 메모리에서 직접 조회
- 지연 셰이딩의 G-Buffer 조합, 톤매핑 등 타일 기반 GPU의 대역폭 최적화에 사용
- `VkRenderPass` 서브패스 구조 없이 동적 렌더링에서 서브패스 입력과 동등한 메모리 효율 달성

### 의존성

- `VK_KHR_dynamic_rendering` (또는 Vulkan 1.3 이상)

### 사용 방법

```c
// 파이프라인 생성 시 입력 첨부 인덱스 매핑 지정
VkRenderingInputAttachmentIndexInfo inputInfo = {
    .sType = VK_STRUCTURE_TYPE_RENDERING_INPUT_ATTACHMENT_INDEX_INFO,
    .colorAttachmentCount = 2,
    .pColorAttachmentIndices = (uint32_t[]){ 0, 1 },  // 색상 첨부 0번과 1번을 입력 첨부로 매핑
    .pDepthAttachmentIndex = NULL,
    .pStencilAttachmentIndex = NULL,
};

// VkGraphicsPipelineCreateInfo::pNext 체인에 inputInfo 연결
```

---

## 11. VK_EXT_load_store_op_none — 첨부 로드/스토어 None 연산

> **`STORE_OP_NONE`: Vulkan 1.3 코어 (`VK_KHR_dynamic_rendering` 유래) | `LOAD_OP_NONE`: Vulkan 1.4 코어 승격**

### 용도

- `VK_ATTACHMENT_LOAD_OP_NONE`: 이전 프레임/패스의 첨부 내용을 보존하면서도 불필요한 로드 메모리 동기화 및 캐시 플러시 생략 (1.4 코어)
- `VK_ATTACHMENT_STORE_OP_NONE`: 렌더 패스 종료 시 첨부 데이터를 보존하면서 명시적 스토어 동기화 오버헤드 제거 (1.3 코어)
- 타일 기반 렌더러(TBR/TBDR) 및 일반 GPU에서 불필요한 VRAM 읽기·쓰기 트래픽을 방지하여 전력 소모와 대역폭 절감
- 멀티패스 렌더링 파이프라인에서 특정 패스가 첨부의 일부 영역만 갱신하거나 읽기 전용으로 참조할 때 유용

### 사용 방법

```c
VkRenderingAttachmentInfo attachment = {
    .sType = VK_STRUCTURE_TYPE_RENDERING_ATTACHMENT_INFO,
    .imageView = gbufferAlbedo,
    .imageLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL,
    .loadOp = VK_ATTACHMENT_LOAD_OP_NONE,    // 기존 내용 유지, 로드 동기화 생략
    .storeOp = VK_ATTACHMENT_STORE_OP_NONE,   // 내용 보존, 스토어 동기화 생략
};
```

---

## 12. VK_KHR_fragment_shading_rate — 프래그먼트 셰이딩 레이트

> **Roadmap 2026 필수 | 가변 해상도 셰이딩(VRS)**

### 용도

- 렌더 타깃 영역별로 프래그먼트 셰이더 실행 빈도를 가변적으로 적용 (`1x1`, `1x2`, `2x1`, `2x2`, `4x4` 등)
- 시선 추적 기반 중심와 렌더링(Foveated Rendering) 및 콘텐츠 기반 가변 비율 셰이딩(VRS) 구현
- 고주파 디테일 영역은 정밀하게 연산하고 평탄한 영역이나 모션 블러 구간은 셰이딩 빈도를 낮춰 렌더링 부하 대폭 절감
- 파이프라인 상태, 프리미티브 속성, VRS 첨부 맵(Attachment Image) 등 세 가지 경로를 조합하여 유연하게 제어

### 셰이딩 레이트 종류

| 레이트 | 픽셀당 셰이더 실행 횟수 | 상대 처리량 |
|--------|------------------------|-------------|
| `1x1` | 픽셀 1개당 1회 실행 | 기준 품질 |
| `1x2` | 픽셀 2개당 1회 실행 | 약 2배 연산 절감 |
| `2x1` | 픽셀 2개당 1회 실행 | 약 2배 연산 절감 |
| `2x2` | 픽셀 4개당 1회 실행 | 약 4배 연산 절감 |
| `4x4` | 픽셀 16개당 1회 실행 | 최대 16배 연산 절감 |

### 의존성

- `VK_KHR_dynamic_rendering` (또는 Vulkan 1.3 이상)
- `VK_KHR_fragment_shading_rate` 디바이스 확장

### 사용 방법

```c
// 1. 기능 활성화 (디바이스 생성 시 pNext에 체이닝)
VkPhysicalDeviceFragmentShadingRateFeaturesKHR fsrFeatures = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_SHADING_RATE_FEATURES_KHR,
    .pipelineFragmentShadingRate = VK_TRUE,
    .primitiveFragmentShadingRate = VK_TRUE,
    .attachmentFragmentShadingRate = VK_TRUE,
};

// 파이프라인 생성 시 동적 상태 선언 필수
// VkPipelineDynamicStateCreateInfo::pDynamicStates에
// VK_DYNAMIC_STATE_FRAGMENT_SHADING_RATE_KHR 포함

// 2. 커맨드 버퍼에서 동적 상태로 설정
VkExtent2D fragmentSize = { 2, 2 }; // 2x2 픽셀 단위로 셰이딩
VkFragmentShadingRateCombinerOpKHR combinerOps[2] = {
    VK_FRAGMENT_SHADING_RATE_COMBINER_OP_KEEP_KHR,
    VK_FRAGMENT_SHADING_RATE_COMBINER_OP_KEEP_KHR,
};

vkCmdSetFragmentShadingRateKHR(
    commandBuffer,
    &fragmentSize,
    combinerOps
);

// 3. 첨부 이미지(VRS Density Map)를 통한 화면 전체 가변 제어
VkRenderingFragmentShadingRateAttachmentInfoKHR fsrAttachment = {
    .sType = VK_STRUCTURE_TYPE_RENDERING_FRAGMENT_SHADING_RATE_ATTACHMENT_INFO_KHR,
    .imageView = vrsMapImageView,
    .texelSize = { 16, 16 },  // 각 텍셀이 16x16 픽셀 영역을 제어
};

// 4. 프리미티브 단위 제어 (GLSL)
// layout(primitive_shading_rate = 4) out int gl_ShadingRateEXT;
```
