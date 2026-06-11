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

---

---

## 3. 기존 파이프라인 대비 메시 셰이더의 장점

- **출력 버퍼 미리 할당 불필요**  
  메시 셰이더 출력은 래스터라이저가 바로 소비한다. Compute로 지오메트리를 만들고 indirect draw를 쓰는 방식처럼, 최대 버텍스/프리미티브 수만큼 버퍼를 미리 잡아둘 필요가 없다.

- **효율적인 컬링**  
  Task shader에서 메시렛(삼각형 클러스터) 단위로 가시성·거리 테스트를 하고, 보이는 것만 메시 셰이더로 넘길 수 있다. 기존 vertex 파이프라인은 버텍스가 이미 입력된 뒤라, 지오메트리 단위 컬링이 제한적이다.

- **LOD·절차적 생성에 유리**  
  Task shader가 생성할 메시 워크그룹 개수를 바꿀 수 있어, 거리·품질에 따라 다른 LOD나 절차적으로 생성한 지오메트리를 한 파이프라인에서 처리하기 좋다.

- **프리미티브 토폴로지 직접 제어**  
  생성되는 삼각형·라인의 인덱스를 셰이더에서 직접 쓰므로, 터셀레이션처럼 “고정된 분할”에 묶이지 않고, 원하는 형태의 메시를 유연하게 만든다.

- **버텍스·프리미티브 작업을 한 워크그룹에서 처리**  
  Geometry shader는 스레드당 한 프리미티브씩 처리하는데 비해, 메시 셰이더는 워크그룹 단위로 협력해 버텍스와 프리미티브를 같이 처리한다. 현대 GPU의 워크그룹/스레드 모델에 더 잘 맞는다.

- **고정 함수 단계 제거**  
  입력 어셈블리·고정 함수 버텍스 페치가 없어지고, 필요한 데이터는 전부 셰이더에서 로드한다. 버텍스 레이아웃·스트리핑 방식을 앱이 완전히 결정할 수 있다.

즉, 과정이 줄어들어 기존 파이프라인보다 대역폭에 유리하며 더 빠르게 동작한다.

---

---

## 4. 지원 현황

### 4.1 VK_EXT_mesh_shader 하드웨어/드라이버

| 벤더 | 하드웨어 | 드라이버/비고 |
|------|----------|----------------|
| **NVIDIA** | Turing 이상 (RTX 20 시리즈 등) | 드라이버 지원 |
| **AMD** | RDNA2 (RX 6000 시리즈 등) | Mesa RADV 22.0+ (실험적 → 점진적 안정화) |
| **Intel** | Arc DG2 / Alchemist | ANV Vulkan 드라이버에 실험적 메시 셰이더 지원 |

### 4.2 기능별 지원 비율 (Vulkan Hardware Database 기준)

- **meshShader**: 약 9.94% 디바이스
- **taskShader**: 약 9.78% 디바이스
- **meshShaderQueries**: 약 6.18% 디바이스

→ 아직 상대적으로 도입률이 낮은 기능이므로, 폴백 파이프라인(기존 vertex/geometry) 유지가 필요하다.

### 4.3 확장 사용 시 주의

- **VK_EXT_mesh_shader**는 공식으로 채택된 EXT 확장이지만, KHR이 아니라서 벤더별 성능/동작 차이는 있을 수 있다.
- 메시 셰이더가 항상 유리한 것은 아니며, 단순한 지오메트리에는 기존 vertex 파이프라인이 더 적합할 수 있다. 고복잡도 지오메트리, 컬링, LOD, 절차적 생성 등에서 메시 셰이더 이점이 크다.

---

## 16. Mesh Shader Pipeline (Vulkan 1.3 / VK_EXT_mesh_shader)

기존의 Vertex → Tessellation → Geometry 대신, Task Shader + Mesh Shader를 사용할 수 있다.

| 전통적 파이프라인 | Mesh 파이프라인 |
|-----------------|---------------|
| Vertex → TCS → TES → GS → Raster | Task → Mesh → Raster |
| 버텍스 버퍼/인덱스 버퍼 필요 | Mesh 셰이더가 직접 프리미티브 생성 |
| 고정 함수 Input Assembly | 프로그래머블 프리미티브 생성 |

```c
// 셰이더 stages
stages[0].stage = VK_SHADER_STAGE_TASK_BIT_EXT;
stages[1].stage = VK_SHADER_STAGE_MESH_BIT_EXT;
stages[2].stage = VK_SHADER_STAGE_FRAGMENT_BIT;

// Vertex Input / Input Assembly는 필요 없음 (pVertexInputState = NULL)
pipelineCI.pVertexInputState = nullptr;
pipelineCI.pInputAssemblyState = nullptr;
```

Mesh 셰이더는 `gl_MeshVerticesEXT[]` 배열을 통해 정점을 생성하고, `gl_PrimitiveTriangleIndicesEXT[]`(삼각형), `gl_PrimitiveLineIndicesEXT[]`(라인), `gl_PrimitivePointIndicesEXT[]`(점) 등으로 프리미티브를 정의한다. 전통적인 버텍스 버퍼가 필요 없어서 **GPU 드리븐 렌더링**이나 **동적 LOD**에 유리하다.
