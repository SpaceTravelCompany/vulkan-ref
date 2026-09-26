---
title: 메시 셰이더
slug: mesh-shader
---

## 1. 개요

Vulkan 메시 셰이더(`VK_EXT_mesh_shader`)는 전통적인 정점 입력·어셈블리, 버텍스, 테셀레이션, 지오메트리 셰이더 단계로 이어지는 고정·가변 혼합 파이프라인을 대체하는 새로운 지오메트리 처리 모델이다. 컴퓨트 셰이더와 유사한 협력형 워크그룹(Workgroup) 프로그래밍 방식을 따르며, 메시렛(Meshlet) 단위의 세밀한 가시성 컬링, 동적 LOD 제어, 절차적 기하 생성에서 높은 효율성을 제공한다.

### 관련 확장 규격

| 확장명 | 유형 | 공식 상태 | 지원 프리미티브 | 비고 |
|--------|------|-----------|----------------|------|
| **VK_EXT_mesh_shader** | 크로스 벤더 (Extension #329) | Khronos 공식 비준 (Ratified) | points, lines, triangles | 현대 GPU 표준 규격 (권장) |
| **VK_NV_mesh_shader** | 벤더 전용 (NVIDIA) | 비공식 규격 (Vendor Specific) | points, lines, triangles | 2018년 Turing 아키텍처에서 최초 도입 |

> [!IMPORTANT]
> 메시 셰이더 파이프라인을 활성화하면 전통적인 정점 처리 단계(Vertex, Tessellation, Geometry)는 비활성화되며 함께 연결할 수 없다. 또한 메시 셰이더의 출력 프리미티브는 하드웨어 래스터라이저가 직접 소비하므로, 지오메트리 생성 결과를 VRAM 버퍼에 별도로 저장할 필요가 없다.

---

## 2. 파이프라인 구조

### 2.1 셰이더 스테이지

메시 셰이더 파이프라인은 선택 단계인 **Task Shader**와 필수 단계인 **Mesh Shader**로 구성된다.

| 스테이지 | 필수 여부 | 역할 |
|----------|-----------|------|
| **Task Shader** (TaskEXT) | 선택 | 지오메트리 증폭, 가시성 컬링, 동적 LOD 판정, 메시 워크그룹 생성량 결정, Task Payload 출력 |
| **Mesh Shader** (MeshEXT) | 필수 | 워크그룹 내부 스레드들이 협력하여 정점 및 프리미티브 속성과 인덱스 생성 |

- **Task Shader**: 하나의 워크그룹이 `EmitMeshTasksEXT` 명령을 호출해 가변 개수의 하위 메시 셰이더 워크그룹을 동적으로 발행한다. 메시렛 단위 절두체/오클루전 컬링을 수행하여 보이지 않는 지오메트리는 메시 셰이더 실행 단계 이전에서 조기 차단한다.
- **Mesh Shader**: 워크그룹 내 스레드들이 온칩 메모리를 활용해 협력적으로 정점 및 프리미티브 데이터를 계산한 후 래스터라이저로 직접 출력한다.

```flowchart
flowchart TD
  A["전통적 파이프라인"]
  A1["Vertex Buffer → Vertex Input/IA → Vertex Shader"]
  A2["→ Tessellation/Geometry → Rasterizer → Fragment Shader"]
  A --> A1 --> A2

  B["메시 셰이더 파이프라인"]
  B1["Scene/Meshlet Buffer → Task Shader (선택: 컬링/LOD)"]
  B2["→ Mesh Shader (정점·프리미티브 생성)"]
  B3["→ Rasterizer → Fragment Shader"]
  B --> B1 --> B2 --> B3
```

### 2.2 지원 프리미티브

`VK_EXT_mesh_shader`와 `VK_NV_mesh_shader` 모두 **points, lines, triangles**의 3가지 출력 기본 도형을 지원한다.

- **VK_EXT_mesh_shader**: `points`, `lines`, `triangles` 모드를 모두 지원하며, 각 모드에 맞춰 `gl_PrimitivePointIndicesEXT[]`, `gl_PrimitiveLineIndicesEXT[]`, `gl_PrimitiveTriangleIndicesEXT[]` 내장 배열을 사용해 인덱스를 정의한다.
- **VK_NV_mesh_shader**: 마찬가지로 3가지 토폴로지를 지원하지만, 인덱스 배열이 `gl_PrimitiveIndicesNV[]` 단일 배열로 통합되어 있다.

### 2.3 전체 실행 절차

메시 셰이더는 단순한 API 호출 변경이 아니라 파이프라인 설정 전체가 재구성되는 독립 렌더링 경로다.

| 순서 | 작업 단계 | 핵심 API 및 객체 |
|------|-----------|------------------|
| 1 | 확장 및 피처 지원 확인 | `VK_EXT_mesh_shader`, `VkPhysicalDeviceMeshShaderFeaturesEXT` |
| 2 | 논리 디바이스 생성 시 피처 활성화 | `taskShader`, `meshShader` 플래그 활성화 |
| 3 | 지오메트리 데이터 준비 | SSBO 또는 UBO에 메시렛(정점, 인덱스, 경계 구) 데이터 업로드 |
| 4 | 셰이더 코드 작성 및 SPIR-V 컴파일 | `.task`, `.mesh` GLSL 작성 후 `glslangValidator` 등으로 SPIR-V 변환 |
| 5 | 그래픽스 파이프라인 생성 | `pVertexInputState`와 `pInputAssemblyState`를 `NULL`로 지정하고 Task/Mesh/Fragment 스테이지 연결 |
| 6 | 파이프라인 바인딩 및 드로우 호출 | `vkCmdDrawMeshTasksEXT` 또는 인다이렉트 커맨드 실행 |
| 7 | 래스터화 및 프래그먼트 처리 | 메시 셰이더 출력 데이터가 고정 함수 래스터라이저를 거쳐 픽셀로 렌더링 |

---

## 3. 기존 지오메트리 파이프라인 대비 장점

1. **중간 출력 메모리 할당 제거**  
   컴퓨트 셰이더 기반 지오메트리 생성 방식은 최악의 상황(최대 프리미티브 수)을 가정한 거대한 VRAM 버퍼를 사전에 할당해야 했다. 메시 셰이더는 칩 내부 온칩 버퍼를 통해 출력이 하드웨어 래스터라이저로 직접 스트리밍되므로 VRAM 대역폭과 메모리 낭비가 없다.

2. **메시렛 단위의 고속 계층 컬링**  
   Task 셰이더 단계에서 64~128개 삼각형으로 이루어진 메시렛 단위 바운딩 볼륨을 검사하여, 화면 밖이거나 가려진 기하를 메시 셰이더 워크그룹 발행 자체에서 완전히 배제한다.

3. **동적 LOD 및 절차적 기하 증폭**  
   화면과의 거리에 따라 메시 셰이더 워크그룹 수를 유연하게 조절하거나 지형, 헤어, 파티클 등 복잡한 기하를 실시간으로 생성할 수 있다.

4. **현대 GPU 하드웨어에 최적화된 협력 모델**  
   과거 지오메트리 셰이더(GS)는 스레드 하나가 프리미티브를 단독 처리하여 하드웨어 워프(Warp/Wavefront) 활용도가 낮았다. 메시 셰이더는 32~128개 스레드로 구성된 워크그룹이 정점과 프리미티브를 병렬 분담하므로 GPU 점유율(Occupancy)이 극대화된다.

5. **고정 함수 정점 입력 병목 제거**  
   고정 함수 인풋 어셈블러를 거치지 않고 SSBO에서 필요한 버텍스 포맷을 셰이더 코드로 직접 디코딩(Vertex Pulling)하므로, 비표준 압축 포맷이나 8비트/16비트 양자화 데이터를 자유롭게 다룰 수 있다.

---

## 4. 디바이스 확장 및 피처 활성화

메시 셰이더를 사용하려면 디바이스 생성 시 `VK_EXT_mesh_shader` 확장을 등록하고 `VkPhysicalDeviceMeshShaderFeaturesEXT` 구조체를 체이닝하여 피처를 활성화해야 한다.

```c
// 1. 물리 디바이스의 메시 셰이더 피처 지원 여부 조회
VkPhysicalDeviceMeshShaderFeaturesEXT meshFeatures{};
meshFeatures.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MESH_SHADER_FEATURES_EXT;

VkPhysicalDeviceFeatures2 features2{};
features2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
features2.pNext = &meshFeatures;

vkGetPhysicalDeviceFeatures2(physicalDevice, &features2);

// 2. 논리 디바이스 생성 시 피처 활성화
VkPhysicalDeviceMeshShaderFeaturesEXT enableMesh{};
enableMesh.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MESH_SHADER_FEATURES_EXT;
enableMesh.pNext = deviceCreateInfo.pNext;
enableMesh.meshShader = VK_TRUE;               // Mesh Shader 필수 활성화
enableMesh.taskShader = VK_TRUE;               // Task Shader 사용 시 활성화
enableMesh.multiviewMeshShader = VK_FALSE;     // VR/멀티뷰 렌더링 필요 시
enableMesh.primitiveFragmentShadingRateMeshShader = VK_FALSE;
enableMesh.meshShaderQueries = VK_FALSE;       // 파이프라인 통계 쿼리 사용 시

deviceCreateInfo.pNext = &enableMesh;
vkCreateDevice(physicalDevice, &deviceCreateInfo, nullptr, &device);
```

### 주요 피처 플래그
- `meshShader`: `VK_TRUE`여야 `VK_SHADER_STAGE_MESH_BIT_EXT` 및 파이프라인 생성이 가능하다.
- `taskShader`: `VK_TRUE`여야 `VK_SHADER_STAGE_TASK_BIT_EXT`를 활성화할 수 있다.
- `multiviewMeshShader`: 멀티뷰 렌더 패스에서 메시 셰이더를 사용할 때 필요하며, `multiview` 피처도 함께 켜야 한다.
- `meshShaderQueries`: `VK_QUERY_TYPE_MESH_PRIMITIVES_GENERATED_EXT` 쿼리 사용 시 필수다.

---

## 5. GLSL 셰이더 구현 예제

### 5.1 기본 단일 삼각형 Mesh Shader

```glsl
#version 460
#extension GL_EXT_mesh_shader : require

// 워크그룹 크기: 1개 스레드
layout(local_size_x = 1, local_size_y = 1, local_size_z = 1) in;

// 출력 기본 도형: 삼각형
layout(triangles) out;

// 워크그룹당 최대 출력 한도 선언
layout(max_vertices = 3, max_primitives = 1) out;

// 프래그먼트 셰이더로 보낼 정점별 색상 속성
layout(location = 0) out vec3 v_color[];

void main() {
    // 실제 출력할 정점 수와 프리미티브 수를 명시 (출력 데이터 기록 전에 반드시 호출)
    SetMeshOutputsEXT(3, 1);

    // 정점 위치 및 속성 기록
    gl_MeshVerticesEXT[0].gl_Position = vec4(-0.5, -0.5, 0.0, 1.0);
    v_color[0] = vec3(1.0, 0.0, 0.0);

    gl_MeshVerticesEXT[1].gl_Position = vec4( 0.5, -0.5, 0.0, 1.0);
    v_color[1] = vec3(0.0, 1.0, 0.0);

    gl_MeshVerticesEXT[2].gl_Position = vec4( 0.0,  0.5, 0.0, 1.0);
    v_color[2] = vec3(0.0, 0.0, 1.0);

    // 삼각형 프리미티브 인덱스 정의: (0, 1, 2)
    gl_PrimitiveTriangleIndicesEXT[0] = uvec3(0, 1, 2);
}
```

### 5.2 워크그룹 협력 Mesh Shader (메시렛 처리)

```glsl
#version 460
#extension GL_EXT_mesh_shader : require

layout(local_size_x = 32, local_size_y = 1, local_size_z = 1) in;
layout(triangles) out;
layout(max_vertices = 64, max_primitives = 126) out;

struct MeshletInfo {
    uint vertexOffset;
    uint vertexCount;
    uint indexOffset;
    uint primitiveCount;
};

layout(std430, binding = 0) readonly buffer MeshletBuffer {
    MeshletInfo meshlets[];
};

layout(location = 0) out vec3 v_normal[];

void main() {
    uint meshletIndex = gl_WorkGroupID.x;
    uint threadId = gl_LocalInvocationIndex;

    uint vertCount = meshlets[meshletIndex].vertexCount;
    uint primCount = meshlets[meshletIndex].primitiveCount;

    // 워크그룹 내 모든 스레드가 동일한 값으로 호출해야 함
    SetMeshOutputsEXT(vertCount, primCount);

    // 1. 정점 데이터 병렬 계산
    for (uint i = threadId; i < vertCount; i += gl_WorkGroupSize.x) {
        // 정점 위치 및 법선 로드/계산
        gl_MeshVerticesEXT[i].gl_Position = vec4(0.0); // 계산식 적용
        v_normal[i] = vec3(0.0, 1.0, 0.0);
    }

    // 2. 프리미티브 인덱스 병렬 기록
    for (uint i = threadId; i < primCount; i += gl_WorkGroupSize.x) {
        gl_PrimitiveTriangleIndicesEXT[i] = uvec3(0, 1, 2); // 인덱스 계산식 적용
    }
}
```

### 5.3 Task Shader와 Mesh Shader 연계

**Task Shader (`.task`)**:
```glsl
#version 460
#extension GL_EXT_mesh_shader : require

layout(local_size_x = 32, local_size_y = 1, local_size_z = 1) in;

// 하위 메시 셰이더로 전달할 공유 페이로드
struct TaskPayload {
    uint meshletIndices[32];
};
taskPayloadSharedEXT TaskPayload payload;

shared uint visibleMeshletCount;

void main() {
    if (gl_LocalInvocationIndex == 0) {
        visibleMeshletCount = 0;
    }
    barrier();

    uint candidateId = gl_GlobalInvocationID.x;
    bool isVisible = check_frustum_visibility(candidateId); // 바운딩 볼륨 가시성 검사

    if (isVisible) {
        uint slot = atomicAdd(visibleMeshletCount, 1);
        payload.meshletIndices[slot] = candidateId;
    }
    barrier();

    // 1개 이상의 유효 메시렛이 있는 경우에만 메시 셰이더 워크그룹을 필요한 수만큼 발행
    EmitMeshTasksEXT(visibleMeshletCount, 1, 1);
}
```

**Mesh Shader (`.mesh`)**:
```glsl
#version 460
#extension GL_EXT_mesh_shader : require

layout(local_size_x = 32, local_size_y = 1, local_size_z = 1) in;
layout(triangles) out;
layout(max_vertices = 64, max_primitives = 126) out;

// Task Shader가 전달한 페이로드 (읽기 전용)
struct TaskPayload {
    uint meshletIndices[32];
};
taskPayloadSharedEXT TaskPayload payload;

void main() {
    uint targetMeshlet = payload.meshletIndices[gl_WorkGroupID.x];
    // 해당 메시렛 정점 및 인덱스 렌더링 수행...
}
```

---

## 6. 메시 셰이더 출력 구조

### 6.1 내장 출력 배열

| 내장 변수명 | 타입 | 출력 모드 | 설명 |
|------------|------|-----------|------|
| `gl_MeshVerticesEXT[]` | `gl_MeshPerVertexEXT[]` | 공통 | 정점별 내장 속성 (`gl_Position`, `gl_PointSize`, 클립 거리 등) |
| `gl_PrimitiveTriangleIndicesEXT[]` | `uvec3[]` | `triangles` | 삼각형을 구성하는 3개 정점 인덱스 |
| `gl_PrimitiveLineIndicesEXT[]` | `uvec2[]` | `lines` | 선분을 구성하는 2개 정점 인덱스 |
| `gl_PrimitivePointIndicesEXT[]` | `uint[]` | `points` | 점 프리미티브를 지정하는 1개 정점 인덱스 |

`gl_MeshPerVertexEXT` 구조체 명세:
```glsl
struct gl_MeshPerVertexEXT {
    vec4  gl_Position;
    float gl_PointSize;
    float gl_ClipDistance[];
    float gl_CullDistance[];
};
```

### 6.2 사용자 정의 출력 변수
- 정점 속성은 배열 형식으로 선언한다: `layout(location = 0) out vec3 v_out[];`
- 프리미티브 속성은 `perprimitiveEXT` 한정자를 부여한다:
  ```glsl
  layout(perprimitiveEXT) out struct {
      uint materialIndex;
      bool gl_CullPrimitiveEXT; // 프리미티브 단위 조기 컬링 플래그
  } prim_out[];
  ```

### 6.3 `SetMeshOutputsEXT` 호출 규칙
- 문법: `SetMeshOutputsEXT(uint vertexCount, uint primitiveCount);`
- 정점 및 인덱스 배열에 값을 쓰기 전에 **반드시 먼저 호출**해야 한다.
- 워크그룹 내 모든 스레드에서 **동일한 인자값(Dynamically Uniform)** 으로 호출되어야 한다.
- 워크그룹 실행 중 **최대 한 번만** 호출할 수 있다.
- `layout(max_vertices, max_primitives)` execution mode 값은 0보다 커야 한다(VUID-StandaloneSpirv-MeshEXT-07330, 07331).

---

## 7. 프리미티브 컬링 (`gl_CullPrimitiveEXT`)

메시 셰이더 내부에서 생성한 프리미티브 중 후면 삼각형이나 평면 밖 기하를 선별하여 래스터라이저 전달을 취소할 수 있다.

```glsl
layout(perprimitiveEXT) out struct {
    bool gl_CullPrimitiveEXT;
} prim_out[];

void main() {
    SetMeshOutputsEXT(numVerts, numPrims);

    for (uint i = gl_LocalInvocationIndex; i < numPrims; i += gl_WorkGroupSize.x) {
        // 컬링 조건 만족 시 true 지정 (래스터라이저가 해당 삼각형을 폐기)
        prim_out[i].gl_CullPrimitiveEXT = !is_triangle_visible(i);
    }
}
```

---

## 8. 드로우 커맨드

### 8.1 직접 드로우 (`vkCmdDrawMeshTasksEXT`)

```c
// groupCountX, groupCountY, groupCountZ 발행
vkCmdDrawMeshTasksEXT(commandBuffer, groupCountX, groupCountY, groupCountZ);
```
- Task 셰이더가 파이프라인에 포함된 경우: 인자는 **Task Shader 워크그룹 개수**를 의미한다.
- Task 셰이더가 생략된 경우: 인자는 **Mesh Shader 워크그룹 개수**를 직접 의미한다.

### 8.2 간접 드로우 (`vkCmdDrawMeshTasksIndirectEXT`)

```c
typedef struct VkDrawMeshTasksIndirectCommandEXT {
    uint32_t groupCountX;
    uint32_t groupCountY;
    uint32_t groupCountZ;
} VkDrawMeshTasksIndirectCommandEXT;

vkCmdDrawMeshTasksIndirectEXT(
    commandBuffer,
    indirectBuffer, // VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT
    offset,
    drawCount,
    stride
);
```

GPU 컴퓨트 셰이더가 가시성 테스트를 마친 후 `indirectBuffer`에 직접 워크그룹 수를 기록하여 CPU 개입 없는 완전한 GPU-Driven 렌더링 루프를 구성한다.

---

## 9. 하드웨어 한계값 (Limits)

`VkPhysicalDeviceMeshShaderPropertiesEXT`를 통해 물리 디바이스의 제한 사항을 조회한다.

### 9.1 주요 한계값 (최소 보장 사양)

| 프로퍼티 | 최소 보장값 | 설명 |
|----------|------------|------|
| `maxTaskWorkGroupInvocations` | 128 | Task 워크그룹 내 최대 스레드 수 |
| `maxTaskWorkGroupSize` | (128, 128, 128) | Task 워크그룹 차원별 최대 크기 |
| `maxTaskPayloadSize` | 16,384 (16KB) | Task Shader가 Mesh로 넘길 수 있는 페이로드 크기 |
| `maxTaskSharedMemorySize` | 32,768 (32KB) | Task Shader 온칩 공유 메모리 크기 |
| `maxMeshWorkGroupInvocations` | **128** | Mesh 워크그룹 내 최대 스레드 수 |
| `maxMeshWorkGroupSize` | **(128, 128, 128)** | Mesh 워크그룹 차원별 최대 크기 |
| `maxMeshOutputVertices` | **256** | 워크그룹당 최대 출력 정점 개수 |
| `maxMeshOutputPrimitives` | **256** | 워크그룹당 최대 출력 프리미티브 개수 |
| `maxMeshOutputMemorySize` | 32,768 (32KB) | 메시 셰이더 출력 메모리 최대 한도 |
| `maxMeshSharedMemorySize` | 28,672 (28KB) | 메시 셰이더 온칩 공유 메모리 크기 |
| `maxMeshPayloadAndSharedMemorySize` | 28,672 (28KB) | Task Payload + Shared Memory 합 상한 |
| `maxMeshPayloadAndOutputMemorySize` | 48,128 (47KB) | Task Payload + Output Memory 합 상한 |
| `maxTaskPayloadAndSharedMemorySize` | 32,768 (32KB) | Task Payload + Task Shared Memory 합 상한 |
| `maxMeshOutputLayers` | 8 | 최대 출력 레이어 수 |
| `maxMeshOutputComponents` | 128 | 정점별 출력 컴포넌트 수 상한 |
| `meshOutputPerVertexGranularity` | $\le 32$ | 정점 출력 메모리 할당 단위 (배수 정렬) |
| `meshOutputPerPrimitiveGranularity` | $\le 32$ | 프리미티브 출력 메모리 할당 단위 |

---

## 10. `VK_EXT_mesh_shader`와 `VK_NV_mesh_shader` 비교

| 항목 | VK_EXT_mesh_shader | VK_NV_mesh_shader |
|------|--------------------|--------------------|
| **표준 상태** | Khronos 공식 비준 (크로스 벤더) | NVIDIA 전용 벤더 확장 |
| **출력 토폴로지** | **points, lines, triangles** | **points, lines, triangles** |
| **내장 인덱스 배열** | 토폴로지별 분리 (`gl_PrimitivePointIndicesEXT[]`, `gl_PrimitiveLineIndicesEXT[]`, `gl_PrimitiveTriangleIndicesEXT[]`) | `gl_PrimitiveIndicesNV[]` 단일 배열 통합 |
| **디스패치 차원** | 3차원 그리드 (`groupCountX, Y, Z`) | **1차원만 지원** (`taskCount, firstTask`) |
| **최소 보장 워크그룹 Shape** | **(128, 128, 128)** | **(32, 1, 1)** |
| **최소 보장 Invocations** | **128** | **32** |
| **Task 생성 방식** | `EmitMeshTasksEXT(x, y, z)` | `gl_TaskCountNV = n` 변수 대입 |
| **Task Payload 전달** | `taskPayloadSharedEXT` 단일 구조체 | `pertaskNV` 한정자 개별 출력 변수 |
| **컬링 메커니즘** | `gl_CullPrimitiveEXT` 불리언 플래그 | 인덱스 수 수동 조정 |
| **SPIR-V 확장** | `SPV_EXT_mesh_shader` | `SPV_NV_mesh_shader` |

> [!NOTE]
> 신규 엔진이나 렌더러는 크로스 벤더 표준인 `VK_EXT_mesh_shader`를 기본 경로로 채택해야 한다. 구형 튜링 아키텍처 드라이버 호환이 필요한 레거시 코드베이스에서만 `VK_NV_mesh_shader`를 고려한다. 두 Execution Model을 **같은 SPIR-V 모듈에 혼용할 수 없다**(VUID-StandaloneSpirv-MeshEXT-07102).

---

## 11. 출력 힌트 프로퍼티 (`prefers*`)

`VkPhysicalDeviceMeshShaderPropertiesEXT`는 하드웨어가 선호하는 출력 패턴을 알려주는 힌트를 제공한다.

| 프로퍼티 | 의미 | 권장 패턴 |
|----------|------|-----------|
| `prefersLocalInvocationVertexOutput` | `VK_TRUE`면 정점 배열 인덱스 = `gl_LocalInvocationIndex`가 유리 | 스레드 ID를 정점 인덱스로 직접 사용 |
| `prefersLocalInvocationPrimitiveOutput` | `VK_TRUE`면 프리미티브 배열 인덱스 = `gl_LocalInvocationIndex`가 유리 | 스레드 ID를 프리미티브 인덱스로 직접 사용 |
| `prefersCompactVertexOutput` | `VK_TRUE`면 컬링 후 정점 배열을 compaction하는 것이 유리 | 살아있는 정점만 연속 배치 + `SetMeshOutputsEXT`로 실제 개수 전달 |
| `prefersCompactPrimitiveOutput` | `VK_TRUE`면 컬링 후 프리미티브 배열을 compaction하는 것이 유리 | 살아있는 프리미티브만 연속 배치 |

- **컬링 비율이 높을 때**: `prefersCompact*`가 `VK_TRUE`이면 `gl_CullPrimitiveEXT` 대신 compaction(인덱스 재배치 + `SetMeshOutputsEXT` 조정)을 사용한다.
- **컬링 비율이 낮을 때**: `gl_CullPrimitiveEXT[i] = true/false`로 개별 프리미티브를 폐기하는 방식이 더 간단하다.

---

## 12. Shader Objects와 `VK_SHADER_CREATE_NO_TASK_SHADER_BIT_EXT`

Shader Objects(`VK_EXT_shader_object`)로 메시 셰이더를 사용할 때는 `nextStage` 체이닝과 `VK_SHADER_CREATE_NO_TASK_SHADER_BIT_EXT` 플래그로 스테이지 연결을 명시한다.

```c
// 예제 A: Task shader 없이 Mesh shader만 사용
VkShaderCreateInfoEXT meshOnlyInfo{};
meshOnlyInfo.sType     = VK_STRUCTURE_TYPE_SHADER_CREATE_INFO_EXT;
meshOnlyInfo.flags     = VK_SHADER_CREATE_NO_TASK_SHADER_BIT_EXT;
meshOnlyInfo.stage     = VK_SHADER_STAGE_MESH_BIT_EXT;
meshOnlyInfo.nextStage = VK_SHADER_STAGE_FRAGMENT_BIT;

// 바인딩 (task stage 제외)
VkShaderStageFlagBits stagesNoTask[] = {
    VK_SHADER_STAGE_MESH_BIT_EXT,
    VK_SHADER_STAGE_FRAGMENT_BIT,
};
VkShaderEXT shadersNoTask[] = { meshShader, fragmentShader };
vkCmdBindShadersEXT(commandBuffer, 2, stagesNoTask, shadersNoTask);

// 예제 B: Task + Mesh + Fragment
VkShaderCreateInfoEXT taskInfo{};
taskInfo.sType     = VK_STRUCTURE_TYPE_SHADER_CREATE_INFO_EXT;
taskInfo.stage     = VK_SHADER_STAGE_TASK_BIT_EXT;
taskInfo.nextStage = VK_SHADER_STAGE_MESH_BIT_EXT;

VkShaderCreateInfoEXT meshInfo{};
meshInfo.sType     = VK_STRUCTURE_TYPE_SHADER_CREATE_INFO_EXT;
meshInfo.stage     = VK_SHADER_STAGE_MESH_BIT_EXT;
meshInfo.nextStage = VK_SHADER_STAGE_FRAGMENT_BIT;

VkShaderStageFlagBits stages[] = {
    VK_SHADER_STAGE_TASK_BIT_EXT,
    VK_SHADER_STAGE_MESH_BIT_EXT,
    VK_SHADER_STAGE_FRAGMENT_BIT,
};
VkShaderEXT shaders[] = { taskShader, meshShader, fragmentShader };
vkCmdBindShadersEXT(commandBuffer, 3, stages, shaders);
```

- 메시 셰이더가 `VK_SHADER_CREATE_NO_TASK_SHADER_BIT_EXT` 없이 생성되었다면 task shader도 함께 바인딩해야 한다.
- 반대로 task shader가 없는 메시 셰이더라면 해당 플래그를 사용하고 task stage 바인딩을 생략한다.

---

## 13. 제한 사항

메시 셰이더 파이프라인에는 다음 제약이 적용된다:

- **트랜스폼 피드백 불가**: 메시 셰이더 파이프라인에서 트랜스폼 피드백을 활성화하면 검증 오류(VUID-VkGraphicsPipelineCreateInfo-None-02322).
- **Output 스토리지 클래스 쓰기 전용**: 메시 셰이더의 Output 스토리지 클래스 변수는 읽을 수 없다(VUID-StandaloneSpirv-MeshEXT-07107).
- **ViewIndex 종속 금지**: `gl_MeshVerticesEXT[]` 인덱스와 `gl_PrimitiveTriangleIndicesEXT[]` 값은 `ViewIndex`에 종속될 수 없다(VUID-StandaloneSpirv-MeshEXT-07108 ~ 07111).
- **`meshShaderQueries` 조건**: `VK_QUERY_TYPE_MESH_PRIMITIVES_GENERATED_EXT` 쿼리나 task/mesh invocation 파이프라인 통계 쿼리를 사용하려면 `meshShaderQueries` 피처가 활성화되어 있어야 한다.
- **`OpSetMeshOutputsEXT` 호출 규칙**: 모든 출력 쓰기 전에 반드시 호출해야 하며, 워크그룹 내에서 최대 한 번, dynamically uniform하게 호출해야 한다.

---

## 14. 성능 최적화 가이드

1. **메시렛 크기 최적화**  
   일반적으로 정점 64개, 삼각형 124~126개 수준으로 메시렛을 분할하는 것이 하드웨어 워프 효율과 온칩 캐시 적중에 가장 유리하다.
2. **워크그룹 스레드 수 매칭**  
   - NVIDIA 하드웨어: 워프 크기인 32의 배수(32 또는 64)로 스레드를 설정한다.
   - AMD 하드웨어: 웨이브프런트 크기인 64 또는 128로 설정한다.
   - `maxPreferredMeshWorkGroupInvocations` 값을 조회하여 하드웨어 권장 크기를 우선 적용한다.
3. **메모리 Granularity 고려**  
   `meshOutputPerVertexGranularity`와 `meshOutputPerPrimitiveGranularity` 단위로 메모리가 상향 정렬되므로, 가능한 한 해당 단위의 배수에 가깝게 출력 크기를 설계하여 패딩 손실을 방지한다.
4. **Task Payload 최소화**  
   Task 셰이더에서 Mesh 셰이더로 넘기는 페이로드 크기는 최소한의 인덱스나 LOD 플래그로 한정하고, 대규모 지오메트리 원본 데이터는 VRAM의 SSBO에서 직접 가져온다.

---

## 15. 그래픽스 파이프라인 생성 예제

```c
VkPipelineShaderStageCreateInfo stages[3] = {};

// 1. Task Shader (선택 사항)
stages[0].sType  = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
stages[0].stage  = VK_SHADER_STAGE_TASK_BIT_EXT;
stages[0].module = taskShaderModule;
stages[0].pName  = "main";

// 2. Mesh Shader (필수)
stages[1].sType  = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
stages[1].stage  = VK_SHADER_STAGE_MESH_BIT_EXT;
stages[1].module = meshShaderModule;
stages[1].pName  = "main";

// 3. Fragment Shader (필수)
stages[2].sType  = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
stages[2].stage  = VK_SHADER_STAGE_FRAGMENT_BIT;
stages[2].module = fragmentShaderModule;
stages[2].pName  = "main";

// 정점 입력 상태 포인터는 NULL로 지정
VkGraphicsPipelineCreateInfo pipelineCI{};
pipelineCI.sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO;
pipelineCI.stageCount = 3;
pipelineCI.pStages = stages;
pipelineCI.pVertexInputState = nullptr;
pipelineCI.pInputAssemblyState = nullptr;
pipelineCI.pViewportState = &viewportState;
pipelineCI.pRasterizationState = &rasterState;
pipelineCI.pMultisampleState = &multisampleState;
pipelineCI.pDepthStencilState = &depthStencilState;
pipelineCI.pColorBlendState = &colorBlendState;
pipelineCI.layout = pipelineLayout;
pipelineCI.renderPass = renderPass;

VkPipeline pipeline;
vkCreateGraphicsPipelines(device, pipelineCache, 1, &pipelineCI, nullptr, &pipeline);
```

메시 셰이더는 `gl_MeshVerticesEXT[]`와 각 토폴로지별 인덱스 배열(`gl_PrimitiveTriangleIndicesEXT[]`, `gl_PrimitiveLineIndicesEXT[]`, `gl_PrimitivePointIndicesEXT[]`)을 통해 정점과 기하를 프로그래머블하게 생성한다. 전통적인 정점 버퍼와 인풋 어셈블러 의존성을 제거하여 현대 GPU의 병렬 처리 역량을 극대화할 수 있다.
