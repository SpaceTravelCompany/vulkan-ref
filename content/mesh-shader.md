---
title: 메시 셰이더
slug: mesh-shader
---

## 1. 개요

Vulkan 메시 셰이더는 **전통적인 vertex / tessellation / geometry 셰이더 파이프라인을 대체하는** 대안적인 지오메트리 래스터화 파이프라인을 제공한다. Compute 프로그래밍 모델을 따르며, 고복잡도 지오메트리·컬링·LOD·절차적 생성 등에서 기존 파이프라인 대비 장점이 있다.

### 관련 확장

| 확장명 | 설명 | 비고 |
|--------|------|------|
| **VK_EXT_mesh_shader** | 크로스 벤더 공식 메시 셰이더 (Extension #329) | 2022년 8월 Khronos 공식 채택 |
| **VK_NV_mesh_shader** | NVIDIA 전용 메시 셰이더 | 공식 규격 아님(NVIDIA만 사용), VK_EXT와 상이점 있음 |

- 메시 셰이더 파이프라인 사용 시 **vertex / geometry / tessellation 셰이더는 사용할 수 없다.**
- 메시 셰이더 출력은 래스터라이저가 직접 소비하므로, compute dispatch 후 indirect draw로 버퍼를 미리 할당하는 방식이 필요 없다.

---

## 2. 파이프라인 구조

### 2.1 셰이더 스테이지

| 스테이지 | 필수 여부 | 역할 |
|----------|-----------|------|
| **Task Shader** | 선택 | 지오메트리 증폭, 가변 개수의 메시 셰이더 워크그룹 생성, 선택적 payload 출력 |
| **Mesh Shader** | 필수 | 워크그룹 내에서 협력적으로 프리미티브 집합 생성 (compute 모델) |

- Task shader: 한 워크그룹이 여러 메시 셰이더 워크그룹을 생성할 수 있음 (geometry amplification).
- Task shader payload는 자식 메시 셰이더 워크그룹에서 읽기 전용으로 사용 가능.
- Mesh shader: 공유 메모리처럼 버텍스/인덱스 데이터를 쓰고, 출력은 래스터라이저로 직접 전달.

### 2.2 지원 프리미티브

- **VK_EXT_mesh_shader**: triangles, lines
- **VK_NV_mesh_shader**: triangles, lines, points

### 2.3 전체 사용 흐름

메시 셰이더는 "새로운 draw 명령 하나를 호출하면 자동으로 동작하는 기능"이라기보다, **디바이스 기능 활성화 → 셰이더 작성 → 그래픽스 파이프라인 생성 → 메시 task draw 호출**까지 이어지는 별도 렌더링 경로다. `VK_EXT_mesh_shader` 기준의 전체 흐름은 다음과 같다.

| 단계 | 해야 할 일 | 핵심 API/개념 |
|------|------------|---------------|
| 1 | 지원 여부 확인 | `VK_EXT_mesh_shader`, `VkPhysicalDeviceMeshShaderFeaturesEXT` |
| 2 | 디바이스 생성 시 기능 활성화 | `taskShader`, `meshShader`, 필요 시 `meshShaderQueries` 등 |
| 3 | 입력 데이터 준비 | SSBO/UBO/texture/descriptor, 필요 시 meshlet 데이터 |
| 4 | mesh shader 작성 | `layout(max_vertices, max_primitives)`, `SetMeshOutputsEXT`, `gl_MeshVerticesEXT[]`, primitive indices |
| 5 | 선택적으로 task shader 작성 | 가시성 컬링, LOD 선택, mesh workgroup 개수 결정, payload 전달 |
| 6 | SPIR-V 컴파일 | GLSL/HLSL 셰이더를 Vulkan용 `.spv` 바이너리로 변환 |
| 7 | 그래픽스 파이프라인 생성 | `TASK_BIT_EXT`(선택), `MESH_BIT_EXT`, `FRAGMENT_BIT`; vertex input/input assembly 없음 |
| 8 | descriptor/pipeline/render target 바인딩 | 일반 그래픽스 파이프라인처럼 descriptor set, pipeline, framebuffer 또는 dynamic rendering 설정 |
| 9 | draw 호출 | `vkCmdDrawMeshTasksEXT` 또는 indirect variants |
| 10 | 래스터/fragment 처리 | mesh shader 출력 primitive가 rasterizer와 fragment shader로 전달 |

즉, 전통적인 vertex path와 mesh shader path는 CPU 측 준비 과정부터 다르다.

SPIR-V 컴파일 단계에서는 `.mesh`, `.task` 셰이더 소스를 `.spv`로 만들며, 컴파일 결과 안에 이 셰이더가 Mesh/Task shader라는 정보가 포함된다.

```c
VkShaderModule meshModule = createShaderModule("shader.mesh.spv");

VkPipelineShaderStageCreateInfo meshStage = {
    .sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO,
    .stage = VK_SHADER_STAGE_MESH_BIT_EXT,
    .module = meshModule,
    .pName = "main",
};
```

```text
전통적 경로:
  vertex/index buffer 준비
  → vertex input + input assembly
  → vertex shader
  → optional tessellation/geometry
  → rasterizer
  → fragment shader

Mesh shader 경로:
  meshlet/instance/scene 데이터 준비(주로 SSBO/UBO)
  → optional task shader: 컬링/LOD/mesh workgroup 생성
  → mesh shader: 정점과 primitive를 직접 생성
  → rasterizer
  → fragment shader
```

Task shader는 필수가 아니다. **가장 단순한 사용법**은 task shader 없이 mesh shader만 두고 `vkCmdDrawMeshTasksEXT(commandBuffer, groupCountX, groupCountY, groupCountZ)`를 호출하는 것이다. 이때 draw의 group count는 곧 실행할 mesh shader workgroup 개수다.

Task shader를 쓰는 경우 draw의 group count는 먼저 실행할 task shader workgroup 개수다. 각 task workgroup은 `EmitMeshTasksEXT(x, y, z)`로 자식 mesh shader workgroup을 생성하며, 이 과정에서 보이지 않는 meshlet을 아예 생성하지 않거나 LOD별로 다른 meshlet을 선택할 수 있다.

실제 엔진에서는 보통 다음처럼 구성한다.

```text
초기화 시:
  1. 물리 디바이스에서 EXT mesh shader 지원 확인
  2. logical device 생성 시 meshShader/taskShader feature 활성화
  3. mesh/task/fragment shader module 생성
  4. mesh pipeline 생성
  5. fallback vertex pipeline도 함께 준비

프레임마다:
  1. visible object 또는 meshlet 후보 목록 준비
  2. descriptor set에 scene/instance/meshlet buffer 바인딩
  3. mesh pipeline 바인딩
  4. vkCmdDrawMeshTasksEXT 또는 indirect draw 호출
  5. mesh shader가 primitive를 만들고 fragment shader가 픽셀 처리
```

---

## 3. 기존 파이프라인 대비 메시 셰이더의 장점

- **출력 버퍼 미리 할당 불필요**  
  메시 셰이더 출력은 래스터라이저가 바로 소비한다. Compute로 지오메트리를 만들고 indirect draw를 쓰는 방식처럼, 최대 버텍스/프리미티브 수만큼 버퍼를 미리 잡아둘 필요가 없다.

- **효율적인 컬링**  
  Task shader에서 메시렛(삼각형 클러스터) 단위로 가시성·거리 테스트를 하고, 보이는 것만 메시 셰이더로 넘길 수 있다. 기존 vertex 파이프라인은 버텍스가 이미 입력된 뒤라, 지오메트리 단위 컬링이 제한적이다.

- **LOD·절차적 생성에 유리**  
  Task shader가 생성할 메시 워크그룹 개수를 바꿀 수 있어, 거리·품질에 따라 다른 LOD나 절차적으로 생성한 지오메트리를 한 파이프라인에서 처리하기 좋다.

- **프리미티브 토폴로지 직접 제어**  
  생성되는 삼각형·라인의 인덱스를 셰이더에서 직접 쓰므로, 터셀레이션처럼 "고정된 분할"에 묶이지 않고, 원하는 형태의 메시를 유연하게 만든다.

- **버텍스·프리미티브 작업을 한 워크그룹에서 처리**  
  Geometry shader는 스레드당 한 프리미티브씩 처리하는데 비해, 메시 셰이더는 워크그룹 단위로 협력해 버텍스와 프리미티브를 같이 처리한다. 현대 GPU의 워크그룹/스레드 모델에 더 잘 맞는다.

- **고정 함수 단계 제거**  
  입력 어셈블리·고정 함수 버텍스 페치가 없어지고, 필요한 데이터는 전부 셰이더에서 로드한다. 버텍스 레이아웃·스트리핑 방식을 앱이 완전히 결정할 수 있다.

즉, 과정이 줄어들어 기존 파이프라인보다 대역폭에 유리하며 더 빠르게 동작한다.

---

## 4. 지원 현황

### 4.1 VK_EXT_mesh_shader 하드웨어/드라이버

- 벤더별 지원 여부는 **하드웨어 세대, 드라이버, 배포 시점**에 따라 달라진다.
- 실제 사용 전에는 대상 장치의 기능 조회와 드라이버 릴리스 노트를 함께 확인해야 한다.

### 4.2 기능별 지원 현황

- 외부 집계(Vulkan Hardware Database 등)의 지원률은 시점 의존적이므로, 이 문서에서는 수치를 단정하지 않는다.
- 메시 셰이더 지원이 없는 환경을 고려해 기존 vertex / tessellation / geometry 파이프라인 폴백을 유지하는 편이 안전하다.

### 4.3 확장 사용 시 주의

- **VK_EXT_mesh_shader**는 공식으로 채택된 EXT 확장이지만, KHR이 아니라서 벤더별 성능/동작 차이는 있을 수 있다.
- 메시 셰이더가 항상 유리한 것은 아니며, 단순한 지오메트리에는 기존 vertex 파이프라인이 더 적합할 수 있다. 고복잡도 지오메트리, 컬링, LOD, 절차적 생성 등에서 메시 셰이더 이점이 크다.

---

## 5. 디바이스 활성화

메시 셰이더를 사용하려면 `VK_EXT_mesh_shader` 확장을 디바이스 확장 목록에 포함하고, `VkPhysicalDeviceMeshShaderFeaturesEXT`를 `vkGetPhysicalDeviceFeatures2`로 조회한 뒤 `vkCreateDevice`의 `pNext`에 활성화 구조체를 연결해야 한다.

- `taskShader`/`meshShader`가 `VK_FALSE`이면 해당 shader stage / pipeline stage enum은 사용할 수 없다.
- `multiviewMeshShader`를 활성화하려면 `VkPhysicalDeviceMultiviewFeaturesKHR::multiview`도 함께 활성화해야 한다.
- `primitiveFragmentShadingRateMeshShader`를 활성화하려면 `VkPhysicalDeviceFragmentShadingRateFeaturesKHR::primitiveFragmentShadingRate`도 함께 활성화해야 한다.
- `meshShaderQueries`는 `VK_QUERY_TYPE_MESH_PRIMITIVES_GENERATED_EXT`와 task/mesh invocation pipeline statistics 쿼리의 사용 가능 여부를 뜻한다.

```c
// 1. 피처 조회
VkPhysicalDeviceMeshShaderFeaturesEXT meshFeatures = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MESH_SHADER_FEATURES_EXT,
};
VkPhysicalDeviceFeatures2 features2 = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2,
    .pNext = &meshFeatures,
};
vkGetPhysicalDeviceFeatures2(physicalDevice, &features2);

// 2. 디바이스 생성 시 활성화
VkPhysicalDeviceMeshShaderFeaturesEXT enableMesh = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MESH_SHADER_FEATURES_EXT,
    .pNext = deviceCreateInfo.pNext,
    .taskShader = VK_TRUE,                   // Task shader 사용 시
    .meshShader = VK_TRUE,                   // Mesh shader 필수
    .multiviewMeshShader = VK_FALSE,         // multiview 사용 시 VK_TRUE
    .primitiveFragmentShadingRateMeshShader = VK_FALSE,
    .meshShaderQueries = VK_FALSE,           // query 필요 시 VK_TRUE
};
deviceCreateInfo.pNext = &enableMesh;
```

### 피처 상세

| 피처 | 설명 |
|------|------|
| `taskShader` | Task shader 사용 가능 여부. `VK_FALSE`면 `VK_SHADER_STAGE_TASK_BIT_EXT` / `VK_PIPELINE_STAGE_TASK_SHADER_BIT_EXT`를 사용할 수 없음 |
| `meshShader` | Mesh shader 사용 가능 여부. `VK_FALSE`면 `VK_SHADER_STAGE_MESH_BIT_EXT` / `VK_PIPELINE_STAGE_MESH_SHADER_BIT_EXT`를 사용할 수 없음 |
| `multiviewMeshShader` | multiview render pass에서 메시 셰이더 사용 가능 여부. 활성화 시 `multiview`도 필요 |
| `primitiveFragmentShadingRateMeshShader` | 메시 셰이더에서 primitive fragment shading rate 사용 가능 여부. 활성화 시 `primitiveFragmentShadingRate`도 필요 |
| `meshShaderQueries` | `VK_QUERY_TYPE_MESH_PRIMITIVES_GENERATED_EXT` 및 task/mesh invocation pipeline statistics 쿼리 사용 가능 여부 |

---

## 6. GLSL 셰이더 예제

### 6.1 기본 Mesh Shader (삼각형 1개 출력)

```glsl
#version 460
#extension GL_EXT_mesh_shader : require

// 워크그룹 크기: 1개의 인보케이션
layout(local_size_x = 1, local_size_y = 1, local_size_z = 1) in;

// 출력 토폴로지: 삼각형
layout(triangles) out;

// 최대 출력 버텍스/프리미티브 선언
layout(max_vertices = 3, max_primitives = 1) out;

// per-vertex 출력 (gl_MeshVerticesEXT에 대응)
layout(location = 0) out vec3 v_color[];

void main() {
    // 출력할 버텍스/프리미티브 개수 설정 (반드시 출력 쓰기 전에 호출)
    SetMeshOutputsEXT(3, 1);

    // 버텍스 0
    gl_MeshVerticesEXT[0].gl_Position = vec4(-1.0, -1.0, 0.0, 1.0);
    v_color[0] = vec3(1.0, 0.0, 0.0);
    // 버텍스 1
    gl_MeshVerticesEXT[1].gl_Position = vec4( 1.0, -1.0, 0.0, 1.0);
    v_color[1] = vec3(0.0, 1.0, 0.0);
    // 버텍스 2
    gl_MeshVerticesEXT[2].gl_Position = vec4( 0.0,  1.0, 0.0, 1.0);
    v_color[2] = vec3(0.0, 0.0, 1.0);

    // 프리미티브 0: {0, 1, 2} 구성 삼각형
    gl_PrimitiveTriangleIndicesEXT[0] = uvec3(0, 1, 2);
}
```

### 6.2 워크그룹 협력 Mesh Shader

```glsl
#version 460
#extension GL_EXT_mesh_shader : require

layout(local_size_x = 32, local_size_y = 1, local_size_z = 1) in;
layout(triangles) out;

// 한 워크그룹이 최대 256개 버텍스, 128개 삼각형 출력
layout(max_vertices = 256, max_primitives = 128) out;

// SSBO 입력 (인스턴스 데이터)
struct DrawData {
    mat4 model;
    uint vertex_count;
    uint index_count;
};
layout(binding = 0, std430) readonly buffer DrawDataBuf {
    DrawData draw_data[];
};

// per-vertex 출력
layout(location = 0) out vec3 v_normal[];
layout(location = 1) out vec2 v_uv[];

void main() {
    uint gid = gl_WorkGroupID.x;
    uint lid = gl_LocalInvocationIndex;

    uint total_verts = draw_data[gid].vertex_count;
    uint total_prims = draw_data[gid].index_count / 3;

    // 모든 인보케이션이 협력하여 SetMeshOutputsEXT 호출 (dynamically uniform)
    SetMeshOutputsEXT(total_verts, total_prims);

    // 각 스레드가 맡은 버텍스 처리
    for (uint i = lid; i < total_verts; i += gl_WorkGroupSize.x) {
        // ... 버텍스 위치/속성 계산 및 gl_MeshVerticesEXT[i]에 저장
    }

    // 각 스레드가 맡은 프리미티브 인덱스 설정
    for (uint i = lid; i < total_prims; i += gl_WorkGroupSize.x) {
        // ... 인덱스 계산 후 gl_PrimitiveTriangleIndicesEXT[i] 설정
    }
}
```

### 6.3 Task Shader + Mesh Shader

**task shader**:
```glsl
#version 460
#extension GL_EXT_mesh_shader : require

layout(local_size_x = 1, local_size_y = 1, local_size_z = 1) in;

// Task payload 구조체 (Task shader → Mesh shader 전달)
struct Payload {
    uint base_instance;
    uint lod_level;
};

// payload 변수 선언
taskPayloadEXT Payload p;

void main() {
    uint instance_id = gl_WorkGroupID.x;

    // 인스턴스별 가시성/LOD 판단
    p.base_instance = instance_id;
    // determine_lod는 문서용 예시 함수이다.
    p.lod_level = determine_lod(instance_id);

    // 1개의 메시 워크그룹 생성
    EmitMeshTasksEXT(1u, 1u, 1u);
}
```

**mesh shader**:
```glsl
#version 460
#extension GL_EXT_mesh_shader : require

layout(local_size_x = 32, local_size_y = 1, local_size_z = 1) in;
layout(triangles) out;
layout(max_vertices = 64, max_primitives = 32) out;

// Task shader에서 보낸 payload (읽기 전용)
taskPayloadEXT Payload {
    uint base_instance;
    uint lod_level;
} p;

void main() {
    // p.base_instance, p.lod_level 사용 가능
    // ...
}
```

---

## 7. 메시 셰이더 출력 구조

### 7.1 빌트인 출력 배열

| 빌트인 변수 | 타입 | 설명 |
|------------|------|------|
| `gl_MeshVerticesEXT[]` | `gl_MeshPerVertexEXT` 구조체 배열 | per-vertex: Position, PointSize, ClipDistance, CullDistance 등 |
| `gl_PrimitiveTriangleIndicesEXT[]` | `uvec3[]` | 삼각형 프리미티브의 버텍스 인덱스 |
| `gl_PrimitiveLineIndicesEXT[]` | `uvec2[]` | 라인 프리미티브의 버텍스 인덱스 |
| `gl_PrimitivePointIndicesEXT[]` | `uint[]` | 포인트 프리미티브의 버텍스 인덱스. SPIR-V 레벨에서는 EXT에 정의되었으나, Vulkan API 레벨에서 VK_EXT_mesh_shader는 points를 지원하지 않는다 (NV는 `gl_PrimitiveIndicesNV[]` 사용) |

`gl_MeshPerVertexEXT` 구조체:
```glsl
struct gl_MeshPerVertexEXT {
    vec4  gl_Position;
    float gl_PointSize;
    float gl_ClipDistance[];
    float gl_CullDistance[];
};
```

### 7.2 사용자 정의 출력

- `layout(location = N) out vec3 v_output[];` 형태로 `[]` 배열로 선언.
- 배열 크기는 반드시 `max_vertices = N`과 일치해야 함 (암시적).
- 배열 인덱스 = 버텍스 인덱스와 1:1 대응.

### 7.3 Per-Primitive 출력

프리미티브 단위 출력은 `perprimitiveEXT` 레이아웃으로 선언:

```glsl
layout(perprimitiveEXT) out PerPrimitive {
    uint material_id;
    uint visibility;
} prim[];
```

배열 크기는 `max_primitives = N`과 암시적으로 일치.

### 7.4 출력 개수 설정

```glsl
SetMeshOutputsEXT(uint vertex_count, uint primitive_count);
```

- 반드시 모든 출력을 쓰기 **전에** 호출해야 한다.
- 모든 인보케이션에서 **dynamically uniform**하게 호출해야 한다.
- `vertex_count`는 선언된 `OutputVertices` 이하이어야 하고, `primitive_count`는 선언된 `OutputPrimitivesEXT` 이하이어야 한다.
- `OutputVertices` / `OutputPrimitivesEXT` execution mode 자체는 0보다 커야 한다 (VUID 07330, 07331).
- 런타임 `vertex_count` / `primitive_count`는 선언된 execution mode 값 이하의 dynamically uniform한 값이어야 하며, 선언 상한을 넘을 수 없다.
- 최대 한 번만 호출 가능 (SPIR-V: `OpSetMeshOutputsEXT`).

---

## 8. Task Shader Payload

### 8.1 VK_EXT_mesh_shader 방식 (TaskEXT)

GLSL에서 payload는 `taskPayloadEXT` storage class로 선언:

```glsl
taskPayloadEXT struct Payload {
    uint base_draw_id;
    float lod_bias;
    uint pad;          // 16바이트 정렬 권장
} p;
```

- payload는 Task shader에서 쓰고, EmitMeshTasksEXT로 생성된 모든 Mesh shader에서 읽기 전용으로 접근.
- SPIR-V storage class: `TaskPayloadWorkgroupEXT`.
- 최대 크기: `VkPhysicalDeviceMeshShaderPropertiesEXT::maxTaskPayloadSize` (최소 16384 바이트).
- **TaskPayloadAndSharedMemorySize** 제한을 초과하지 않도록 주의.

TaskNV 방식 (PerTaskNV)와 달리 EXT는 **구조체 포인터** 하나만 넘길 수 있고, payload는 Task shader에서 직접 쓴 후 mesh shader가 읽는다.

### 8.2 VK_NV_mesh_shader 방식 (TaskNV)

```glsl
// TaskNV: 별도 변수 선언 + PerTaskNV decoration
layout(location = 0) pertaskNV out vec3 instance_pos;
layout(location = 1) pertaskNV out uint lod;

void main() {
    instance_pos = ...;
    lod = ...;
    gl_TaskCountNV = 1;  // NV: EmitMeshTasksEXT 대신 TaskCountNV 사용
}
```

---

## 9. 프리미티브 컬링 (CullPrimitiveEXT)

메시 셰이더는 생성한 프리미티브를 개별적으로 컬링할 수 있다.

```glsl
layout(perprimitiveEXT) out struct {
    // CullPrimitiveEXT: 프리미티브 단위 컬링 플래그
    // true → 컬링(폐기), false → 유지
    bool gl_CullPrimitiveEXT;
} prim_out[];
```

사용 예:
```glsl
SetMeshOutputsEXT(num_verts, num_prims);

for (uint i = gl_LocalInvocationIndex; i < num_prims; i += gl_WorkGroupSize.x) {
    // 프리미티브가 절두체 밖이면 컬링
    prim_out[i].gl_CullPrimitiveEXT = !is_visible(i);
}
```

- `CullPrimitiveEXT`는 PerPrimitiveEXT 데코레이션이 필수.
- `true`로 설정된 프리미티브는 래스터라이저에 도달하지 않음.
- NV 확장에서는 `gl_CullPrimitiveEXT` 대신 `gl_PrimitiveIndicesNV[]` 등을 사용한 직접 인덱스 제어 방식.

### 힌트 프로퍼티

`VkPhysicalDeviceMeshShaderPropertiesEXT`에서 다음 힌트 제공:

| 프로퍼티 | 설명 |
|----------|------|
| `prefersCompactVertexOutput` | true면 컬링 후 버텍스 배열을 compaction하는 것이 유리 |
| `prefersCompactPrimitiveOutput` | true면 컬링 후 프리미티브 배열을 compaction하는 것이 유리 |
| `prefersLocalInvocationVertexOutput` | true면 vertex 배열 인덱스 = LocalInvocationIndex가 유리 |
| `prefersLocalInvocationPrimitiveOutput` | true면 primitive 배열 인덱스 = LocalInvocationIndex가 유리 |

---

## 10. 드로우 커맨드

### 10.1 Direct Draw

```c
// Task shader 유무와 상관없이 사용 가능
vkCmdDrawMeshTasksEXT(commandBuffer, groupCountX, groupCountY, groupCountZ);

// Task shader가 있는 경우: groupCount = Task workgroup 개수
// Task shader가 없는 경우: groupCount = Mesh workgroup 개수
```

- `vkCmdDrawMeshTasksEXT`는 `meshShader` feature가 활성화된 디바이스에서만 사용할 수 있다.
- Task shader는 선택 사항이므로, 없는 경우에는 task stage를 파이프라인/shader object에서 생략한다.

### 10.2 Indirect Draw

```c
// VkDrawMeshTasksIndirectCommandEXT 구조체 배열 읽기
typedef struct VkDrawMeshTasksIndirectCommandEXT {
    uint32_t groupCountX;
    uint32_t groupCountY;
    uint32_t groupCountZ;
} VkDrawMeshTasksIndirectCommandEXT;

vkCmdDrawMeshTasksIndirectEXT(
    commandBuffer,
    buffer,              // VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT
    offset,
    drawCount,
    stride
);
```

- `vkCmdDrawMeshTasksIndirectEXT`도 `meshShader` feature가 활성화된 디바이스에서만 사용할 수 있다.

### 10.3 Indirect Draw with Count

```c
vkCmdDrawMeshTasksIndirectCountEXT(
    commandBuffer,
    buffer,
    offset,
    countBuffer,
    countBufferOffset,
    maxDrawCount,
    stride
);
```

- `vkCmdDrawMeshTasksIndirectCountEXT`는 `drawIndirectCount` 지원이 있을 때만 사용할 수 있다.
- `VK_KHR_draw_indirect_count`, `VK_AMD_draw_indirect_count` 또는 Vulkan 1.2 이상에서 사용 가능 여부를 확인해야 한다.
- `vkCmdDrawMeshTasksIndirectCountEXT` 역시 `meshShader` feature가 필요하다.

### 10.4 NV 확장 드로우 커맨드

```c
// NV: 1D only (X dimension만)
typedef struct VkDrawMeshTasksIndirectCommandNV {
    uint32_t taskCount;
    uint32_t firstTask;
} VkDrawMeshTasksIndirectCommandNV;

vkCmdDrawMeshTasksNV(commandBuffer, taskCount, firstTask);
vkCmdDrawMeshTasksIndirectNV(commandBuffer, buffer, offset, drawCount, stride);
```

### 10.5 파이프라인 생성 시 유의사항

```c
VkGraphicsPipelineCreateInfo pipelineCI = {
    .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO,
    // Vertex Input / Input Assembly 상태는 NULL
    .pVertexInputState = NULL,
    .pInputAssemblyState = NULL,
    // Tessellation / Viewport 등은 일반 graphics pipeline과 동일
};

VkPipelineShaderStageCreateInfo stages[] = {
    { .stage = VK_SHADER_STAGE_TASK_BIT_EXT,  ... },
    { .stage = VK_SHADER_STAGE_MESH_BIT_EXT,  ... },
    { .stage = VK_SHADER_STAGE_FRAGMENT_BIT,  ... },
};
```

- 위 예제는 **Task + Mesh + Fragment** 조합의 문서용 의사 코드이다.
- task shader가 없는 파이프라인이라면 `VK_SHADER_STAGE_TASK_BIT_EXT` 항목을 제외해야 한다.
- `VK_SHADER_STAGE_TASK_BIT_EXT` / `VK_SHADER_STAGE_MESH_BIT_EXT`는 각각 대응 feature가 활성화된 경우에만 사용할 수 있다.
- subpass의 view mask가 0이 아니면 `multiviewMeshShader`와 multiview feature가 함께 필요하다.
- mesh shader에서 primitive fragment shading rate를 사용하려면 `primitiveFragmentShadingRateMeshShader`와 `primitiveFragmentShadingRate`가 함께 필요하다.

### 10.6 Shader Objects 사용 시

```c
// 예제 A: Task shader 없이 Mesh shader만 사용
VkShaderCreateInfoEXT meshOnlyInfo = {
    .flags = VK_SHADER_CREATE_NO_TASK_SHADER_BIT_EXT,
    .stage = VK_SHADER_STAGE_MESH_BIT_EXT,
    .nextStage = VK_SHADER_STAGE_FRAGMENT_BIT,
};

// 바인딩 (task stage 제외)
VkShaderStageFlagBits stagesNoTask[] = {
    VK_SHADER_STAGE_MESH_BIT_EXT,
    VK_SHADER_STAGE_FRAGMENT_BIT,
};
VkShaderEXT shadersNoTask[] = { meshShader, fragmentShader };
vkCmdBindShadersEXT(commandBuffer, 2, stagesNoTask, shadersNoTask);

// 예제 B: Task + Mesh + Fragment (task shader 포함)
VkShaderCreateInfoEXT taskInfo = {
    .stage = VK_SHADER_STAGE_TASK_BIT_EXT,
    .nextStage = VK_SHADER_STAGE_MESH_BIT_EXT,
};
VkShaderCreateInfoEXT meshInfo = {
    .stage = VK_SHADER_STAGE_MESH_BIT_EXT,
    .nextStage = VK_SHADER_STAGE_FRAGMENT_BIT,
};

VkShaderStageFlagBits stages[] = {
    VK_SHADER_STAGE_TASK_BIT_EXT,
    VK_SHADER_STAGE_MESH_BIT_EXT,
    VK_SHADER_STAGE_FRAGMENT_BIT,
};
VkShaderEXT shaders[] = { taskShader, meshShader, fragmentShader };
vkCmdBindShadersEXT(commandBuffer, 3, stages, shaders);
```

- shader object만 사용하는 경우에도 `taskShader`/`meshShader` feature 제약은 동일하다.
- graphics pipeline이 없고 mesh shader를 바인딩하는 경우, mesh shader가 `VK_SHADER_CREATE_NO_TASK_SHADER_BIT_EXT` 없이 생성되었다면 task shader도 함께 바인딩해야 한다.
- 반대로 task shader가 없는 mesh shader라면 해당 플래그를 사용하고 task stage 바인딩을 생략한다.

---

## 11. 구현 한계값 (Limits)

`VkPhysicalDeviceMeshShaderPropertiesEXT` 구조체를 통해 디바이스별 한계와 선호도를 조회한다.

### 11.1 주요 한계값 (최소 보장값)

| 한계 | 최소값 | 비고 |
|------|--------|------|
| `maxTaskWorkGroupTotalCount` | $2^{22}$ | Task 워크그룹 총 개수 |
| `maxTaskWorkGroupCount` | (65535, 65535, 65535) | 차원별 최대 |
| `maxTaskWorkGroupInvocations` | 128 | Task 워크그룹 내 인보케이션 수 |
| `maxTaskWorkGroupSize` | (128, 128, 128) | 차원별 최대 |
| `maxTaskPayloadSize` | 16384 (16KB) | Task payload 최대 크기 |
| `maxTaskSharedMemorySize` | 32768 (32KB) | Task 공유 메모리 최대 |
| `maxMeshWorkGroupTotalCount` | $2^{22}$ | Mesh 워크그룹 총 개수 |
| `maxMeshWorkGroupCount` | (65535, 65535, 65535) | 차원별 최대 |
| `maxMeshWorkGroupInvocations` | 128 | Mesh 인보케이션 수 |
| `maxMeshWorkGroupSize` | (128, 128, 128) | 차원별 최대 |
| `maxMeshOutputVertices` | **256** | 워크그룹당 최대 출력 버텍스 |
| `maxMeshOutputPrimitives` | **256** | 워크그룹당 최대 출력 프리미티브 |
| `maxMeshOutputLayers` | 8 | 최대 layer |
| `maxMeshOutputMemorySize` | 32768 (32KB) | 출력 메모리 최대 |
| `meshOutputPerVertexGranularity` | ≤ 32 | 버텍스 할당 단위 (granularity) |
| `maxPreferredTaskWorkGroupInvocations` | 구현 의존 | 선호 Task 인보케이션 |
| `maxPreferredMeshWorkGroupInvocations` | 구현 의존 | 선호 Mesh 인보케이션 |

> **참고**: 위 값은 규격의 최소 보장값이며, 실제 디바이스 기본값은 벤더·세대·드라이버에 따라 달라진다.

### 11.2 메모리 모델

메시 셰이더의 메모리 사용량은 다음 공식으로 계산된다:

```
total_memory = output_memory + shared_memory (+ payload_memory)

제약:
  output_memory               ≤ maxMeshOutputMemorySize
  shared_memory               ≤ maxMeshSharedMemorySize
  output_memory + shared_memory      ≤ maxMeshPayloadAndOutputMemorySize
  (task) payload + shared_memory     ≤ maxTaskPayloadAndSharedMemorySize
```

- `output_memory` = vertex 출력 × per-vertex granularity + primitive 출력 × per-primitive granularity + 출력 컴포넌트
- 실제 할당 단위보다 granularity 값이 출력 개수를 상향 정렬시킴.

---

## 12. VK_NV_mesh_shader vs VK_EXT_mesh_shader 차이점

| 항목 | VK_EXT_mesh_shader | VK_NV_mesh_shader |
|------|--------------------|--------------------|
| **Task → Mesh 전달** | `TaskPayloadWorkgroupEXT` 구조체 포인터 (단일) | `PerTaskNV` output 변수 (다중) |
| **Task workgroup 생성** | `OpEmitMeshTasksEXT(groupX, groupY, groupZ, payload)` | `gl_TaskCountNV = n` (1D만) |
| **Mesh 출력 인덱스** | `gl_PrimitiveTriangleIndicesEXT[]`, `gl_PrimitiveLineIndicesEXT[]` | `gl_PrimitiveIndicesNV[]` (통합) |
| **출력 토폴로지** | triangles, lines | triangles, lines, **points** |
| **워크그룹 차원** | 3D (groupCountX/Y/Z) | **1D only** (taskCount, firstTask) |
| **워크그룹 Shape** | max: (128,128,128), invocations: 128 | max: (32,1,1), invocations: **32** |
| **드로우 커맨드** | `vkCmdDrawMeshTasksEXT` | `vkCmdDrawMeshTasksNV` |
| **Indirect 구조체** | `VkDrawMeshTasksIndirectCommandEXT` (3 × uint32_t) | `VkDrawMeshTasksIndirectCommandNV` (2 × uint32_t) |
| **멀티뷰** | `multiviewMeshShader` 피처 필요 | `gl_MeshViewCountNV`, `gl_MeshViewIndicesNV`, `PositionPerViewNV` 등 내장 |
| **Primitive 컬링** | `gl_CullPrimitiveEXT` (per-primitive bool) | 인덱스 수 제어 방식 |
| **SPIR-V 버전** | SPV_EXT_mesh_shader | SPV_NV_mesh_shader |
| **공식 상태** | Khronos Ratified, 크로스 벤더 | NVIDIA 전용 (Not Ratified) |
| **도입 시기** | 2022년 | 2018년 (Turing) |

> EXT 확장이 NV 확장을 기반으로 설계되었지만, 상당한 차이가 있다. 두 Execution Model을 **같은 모듈에 혼용할 수 없다** (VUID-StandaloneSpirv-MeshEXT-07102).

### 12.1 어떤 확장을 선택해야 하는가

일반적인 신규 코드라면 **`VK_EXT_mesh_shader`를 우선 선택**하는 것이 권장된다. `VK_EXT_mesh_shader`는 ratified 상태의 크로스 벤더 확장이며, Vulkan 1.2 또는 `VK_KHR_spirv_1_4`를 전제로 `SPV_EXT_mesh_shader`와 함께 사용한다. 반면 `VK_NV_mesh_shader`는 먼저 등장한 NVIDIA 전용 확장으로, 기존 NVIDIA 전용 코드나 구형 드라이버 호환성이 필요할 때 주로 고려한다.

---

## 13. 성능 최적화 가이드

### 13.1 워크그룹 크기 선택

- `maxPreferredMeshWorkGroupInvocations`가 0이 아니면 이 값을 기준으로 워크그룹 크기를 설정한다.
- NVIDIA: preferred가 보통 32 (하나의 warp). 32 이상 사용 시 **여러 warp**가 같은 워크그룹에서 협력.
- AMD: preferred가 보통 64 또는 128 (wavefront 크기에 맞춤).
- 출력 버텍스/프리미티브가 적은 경우 작은 워크그룹이 유리.

### 13.2 출력 배열 액세스 패턴

- `prefersLocalInvocationVertexOutput` / `prefersLocalInvocationPrimitiveOutput`가 `VK_TRUE`면:
  - 각 인보케이션이 자신의 `gl_LocalInvocationIndex`에 해당하는 버텍스/프리미티브만 쓰는 것이 유리.
  - 이는 GPU 메모리 시스템이 인보케이션-인덱스 정렬된 액세스를 선호하기 때문.

```glsl
// 권장 패턴 (prefersLocalInvocationVertexOutput == true)
void main() {
    SetMeshOutputsEXT(total_verts, total_prims);
    if (gl_LocalInvocationIndex < total_verts) {
        gl_MeshVerticesEXT[gl_LocalInvocationIndex].gl_Position = ...;
        v_out[gl_LocalInvocationIndex] = ...;
    }
}
```

### 13.3 Compact Output vs CullPrimitiveEXT

- `prefersCompactVertexOutput` / `prefersCompactPrimitiveOutput` 힌트 확인:
  - `true` → 컬링 후 배열 compaction (버텍스/인덱스 재정렬) 방식 사용.
  - `false` → `gl_CullPrimitiveEXT`를 사용하여 컬링만 표시하고 compaction 생략.
- Compaction이 필요한 경우: 출력 인덱스를 재계산하고 `SetMeshOutputsEXT`로 실제 개수를 조정.
- 일반적으로 **프리미티브 컬링 비율이 높으면 compact가 유리**, 낮으면 CullPrimitiveEXT가 유리.

### 13.4 Shared Memory vs Payload

- Task shader에서 계산 결과를 Mesh shader에 전달할 때:
  - **Payload**: Task shader → Mesh shader 전용. 읽기 전용. `maxTaskPayloadSize` 제한.
  - **Shared memory**: Mesh shader 워크그룹 내 인보케이션 간 공유. `maxMeshSharedMemorySize` 제한.
  - 총합이 `maxMeshPayloadAndSharedMemorySize`를 초과하지 않도록 조정.

- 가급적 payload는 작게 유지하고, 필요한 추가 데이터는 SSBO/UBO에서 직접 읽는 방식이 유리.

### 13.5 메시렛 크기 (Meshlet Size)

- 메시렛 = 하나의 Mesh shader 워크그룹이 처리하는 삼각형 클러스터.
- 일반적인 메시렛 크기: 32~128 버텍스, 32~128 프리미티브.
- 큰 메시렛(256 vtx, 256 prim)은 워크그룹 활용도를 높이지만, occupancy와 메모리 압력을 고려해야 함.
- Task shader 컬링 단위로 적절한 메시렛 크기를 선택 (보통 64~128 프리미티브).

### 13.6 메모리 할당 단위 고려

- `meshOutputPerVertexGranularity`와 `meshOutputPerPrimitiveGranularity`만큼 실제 할당이 상향 정렬됨.
- 예: granularity=32일 때 50개 버텍스 요청 → 64개 분할 할당.
- Granularity의 배수로 출력 개수를 설정하면 낭비를 줄일 수 있음.

---

## 14. 제한 사항 및 주의점

### 14.1 파이프라인 제약

- 메시 셰이더 파이프라인에서는 **vertex / tessellation / geometry 셰이더를 사용할 수 없다.**
- 전통적인 vertex input state (`VkPipelineVertexInputStateCreateInfo`)는 **필요 없음** (무시됨, NULL 가능).
- Input assembly state (`VkPipelineInputAssemblyStateCreateInfo`)도 **사용하지 않음**.
- Pipeline statistics query에서 `VK_QUERY_PIPELINE_STATISTIC_VERTEX_SHADER_INVOCATIONS_BIT` 등 기존 stage 관련 플래그는 사용 불가.
- Transform feedback은 mesh shader와 함께 사용할 수 없음.

### 14.2 메시 셰이더 적용이 적합하지 않은 경우

- **단순 오브젝트 / 적은 폴리곤**: 기존 vertex shader가 오버헤드가 더 작음.
- **기존 파이프라인 폴백 필요**: mesh shader 미지원 하드웨어 대응을 위해 두 파이프라인 유지 필요.
- **하드웨어 지원 상황은 시점 의존**: 대상 디바이스에서 기능 조회를 먼저 수행하고, 필요하면 폴백 경로를 유지한다.

### 14.3 SPIR-V 규칙

- `OpSetMeshOutputsEXT`는 모든 출력 쓰기 전에 반드시 호출.
- `OpEmitMeshTasksEXT`는 task shader에서 **정확히 한 번**, dynamically uniform하게 호출.
- `OpSetMeshOutputsEXT`는 mesh shader에서 **최대 한 번**, dynamically uniform하게 호출.
- Output storage class 변수는 읽을 수 없음 (write-only).
- Per-vertex 출력: `gl_MeshVerticesEXT[]` 인덱스는 ViewIndex에 종속될 수 없음.
- Per-primitive 인덱스 (`gl_PrimitiveTriangleIndicesEXT[]`) 값도 ViewIndex에 종속 불가.

### 14.4 쿼리 제약

- `VK_QUERY_TYPE_MESH_PRIMITIVES_GENERATED_EXT`로 생성된 프리미티브 개수 조회 가능.
- 기존 pipeline statistics 쿼리 중 mesh/task 관련 플래그만 사용 가능:
  - `VK_QUERY_PIPELINE_STATISTIC_TASK_SHADER_INVOCATIONS_BIT_EXT`
  - `VK_QUERY_PIPELINE_STATISTIC_MESH_SHADER_INVOCATIONS_BIT_EXT`
- `VK_QUERY_PIPELINE_STATISTIC_INPUT_ASSEMBLY_VERTICES_BIT` 등은 사용 불가.
- `meshShaderQueries`가 `VK_FALSE`이면 위 mesh 관련 쿼리를 생성하지 않는다.

### 14.5 Vulkan 1.3 / 1.4와의 관계

- 이 문서는 `VK_EXT_mesh_shader` 기준으로 설명한다. 코어 승격 여부와 세부 규칙은 대상 Vulkan 사양 버전에서 확인한다.

---

## 15. Mesh Shader Pipeline 생성 예제

기존의 Vertex → Tessellation → Geometry 대신, Task Shader + Mesh Shader를 사용할 수 있다.

| 전통적 파이프라인 | Mesh 파이프라인 |
|-----------------|---------------|
| Vertex → TCS → TES → GS → Raster | Task → Mesh → Raster |
| 버텍스 버퍼/인덱스 버퍼 필요 | Mesh 셰이더가 직접 프리미티브 생성 |
| 고정 함수 Input Assembly | 프로그래머블 프리미티브 생성 |

```c
// 셰이더 stages
VkPipelineShaderStageCreateInfo stages[3] = {};
stages[0].stage = VK_SHADER_STAGE_TASK_BIT_EXT;
stages[0].module = taskShaderModule;
stages[0].pName = "main";
stages[1].stage = VK_SHADER_STAGE_MESH_BIT_EXT;
stages[1].module = meshShaderModule;
stages[1].pName = "main";
stages[2].stage = VK_SHADER_STAGE_FRAGMENT_BIT;
stages[2].module = fragmentShaderModule;
stages[2].pName = "main";

// Vertex Input / Input Assembly는 필요 없음 (pVertexInputState = NULL)
VkGraphicsPipelineCreateInfo pipelineCI = {
    .sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO,
    .stageCount = 3,
    .pStages = stages,
    .pVertexInputState = NULL,
    .pInputAssemblyState = NULL,
    // ... viewport, rasterization, multisample, depth/stencil, color blend 등은 동일
};
vkCreateGraphicsPipelines(device, VK_NULL_HANDLE, 1, &pipelineCI, NULL, &pipeline);
```

Mesh 셰이더는 `gl_MeshVerticesEXT[]` 배열을 통해 정점을 생성하고, `gl_PrimitiveTriangleIndicesEXT[]`(삼각형), `gl_PrimitiveLineIndicesEXT[]`(라인) 등으로 프리미티브를 정의한다. 전통적인 버텍스 버퍼가 필요 없어서 **GPU 드리븐 렌더링**이나 **동적 LOD**에 유리하다. (참고: points 프리미티브는 `VK_NV_mesh_shader` 전용이며 EXT에서는 사용할 수 없다.)
