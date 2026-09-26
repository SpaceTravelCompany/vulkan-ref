---
title: 성능 최적화
slug: performance
---

## 소개

Vulkan은 명시적 제어로 CPU·GPU 오버헤드를 최소화하도록 설계됐다. 대신 렌더 패스, 파이프라인 동기화, 디스크립터 바인딩, 메모리 할당을 애플리케이션에서 직접 관리해야 한다. 이 글은 실무 렌더링 엔진에서 쓰는 최적화 기법을 정리한다.

> **용어 정리**
> - **Render Pass**: 렌더링 대상 어태치먼트(컬러·깊이 등)와 서브패스 간 메모리 의존성을 정의하는 단위.
> - **Descriptor**: 셰이더가 참조하는 버퍼, 텍스처, 샘플러 등의 리소스 바인딩 정보.
> - **Pipeline Barrier**: GPU 작업 단계(Stage) 및 메모리 접근 간의 실행 순서와 데이터 가시성을 제어하는 동기화 도구.

---

## 1. 디스크립터 최적화

디스크립터 바인딩과 갱신은 CPU 오버헤드가 큰 작업에 속한다. 할당 및 갱신 횟수를 최소화하고 데이터 전달 경로를 단순화하는 것이 핵심이다.

| 최적화 기법 | 설명 |
|------------|------|
| **Descriptor Pool 프레임별 리셋** | 프레임별 풀을 구성하고 매 프레임 `vkResetDescriptorPool`로 일괄 재사용하여 개별 할당/해제 오버헤드 제거 |
| **Dynamic UBO/SSBO** | 단일 디스크립터 세트에 동적 오프셋(`dynamicOffsets`)을 적용하여 다중 객체 바인딩 비용 절감 |
| **Descriptor Buffer (`VK_EXT_descriptor_buffer`)** | 드라이버 객체 없이 GPU 버퍼 메모리에 디스크립터 데이터를 직접 기록하여 바인딩 오버헤드 최소화 |
| **Push Descriptor (`VK_KHR_push_descriptor`)** | 디스크립터 풀 할당 없이 커맨드 버퍼에 디스크립터 바인딩을 인라인 형태로 직접 기록 |
| **Push Constants** | 디바이스의 `maxPushConstantsSize` 허용 범위 내에서 작은 상수 데이터를 커맨드 버퍼에 즉각 전달 |
| **Inline Uniform Block (`VK_EXT_inline_uniform_block`)** | 별도의 버퍼 객체 생성 없이 디스크립터 세트 내부에 UBO 데이터를 직접 포함 |

> [!TIP]
> 실무에서는 자주 갱신되는 작은 크기의 데이터(객체 인덱스, 머티리얼 ID 등)에는 **Push Constants**를 적용하고, 프레임별 전역 데이터나 카메라 행렬 등에는 **Dynamic UBO**를 조합하는 패턴이 가장 널리 사용된다.

---

## 2. 메모리 할당 전략

Vulkan 드라이버가 허용하는 최대 메모리 할당 횟수(`maxMemoryAllocationCount`)에는 제한이 있으므로, 작은 크기의 할당을 빈번하게 요청하는 방식은 피해야 한다.

| 방식 | 설명 및 활용 |
|------|-------------|
| **Dedicated Allocation (`VK_KHR_dedicated_allocation`)** | 대형 렌더 타깃이나 깊이 버퍼 등 성능에 민감한 리소스에 전용 물리 메모리 할당 (`vkGet*MemoryRequirements2`로 권장 여부 확인) |
| **Suballocation (하위 할당)** | 대형 `VkDeviceMemory` 블록을 사전에 확보한 뒤 여러 버퍼와 이미지를 오프셋별로 분할 바인딩 (Vulkan Memory Allocator(VMA) 라이브러리 활용 권장, `bufferImageGranularity` 정렬 제약 준수) |
| **Sparse Binding** | 초대형 텍스처나 지형 시스템에서 가상 메모리 페이징 기법을 적용하여 필요한 영역 페이지만 물리 메모리에 선별 바인딩 |

메모리 속성 우선순위:
- GPU 전용 리소스(정점 버퍼, 인덱스 버퍼, 텍스처 등): **`VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT`**
- CPU에서 GPU로 전송할 스테이징 버퍼: **`VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT`** | **`VK_MEMORY_PROPERTY_HOST_COHERENT_BIT`**

---

## 3. 파이프라인 캐시 및 셰이더 컴파일 최적화

파이프라인 생성은 셰이더 컴파일과 최적화 과정을 거치므로 런타임 비용이 매우 높다. 파이프라인 캐시와 라이브러리 확장을 활용해 불필요한 재컴파일을 방지한다.

- **`VkPipelineCache`**: 초기 파이프라인 빌드 결과를 직렬화하여 디스크에 저장(`vkGetPipelineCacheData`)하고, 다음 실행 시 역직렬화하여 로드함으로써 컴파일 시간을 획기적으로 단축.
- **Pipeline Library (`VK_KHR_pipeline_library`)**: 공통 파이프라인 컴포넌트를 라이브러리로 사전 빌드하여 다중 파이프라인 간 공유 및 조합.
- **Shader Module Identifier (`VK_EXT_shader_module_identifier`)**: SPIR-V 코드 전체를 넘기지 않고 컴파일러 식별자 해시를 전달하여 파이프라인 캐시 히트 여부를 고속 검사.
- **Graphics Pipeline Library (`VK_EXT_graphics_pipeline_library`)**: 버텍스 입력, 프래그먼트 셰이더, 블렌드 상태 등을 독립 컴포넌트로 분리 컴파일하여 상태 조합 시 전체 재컴파일 방지.
- **Shader Objects (`VK_EXT_shader_object`)**: 모놀리식 파이프라인(PSO) 구조를 탈피하여 개별 셰이더 스테이지를 동적으로 직접 바인딩.

```flowchart
flowchart TD
  A["최초 실행: SPIR-V 파이프라인 컴파일 (지연 발생)"]
  B(["파이프라인 캐시 디스크 직렬화 저장 — vkGetPipelineCacheData"])
  C["이후 실행: 디스크 캐시 로드 후 빌드 (캐시 히트, 즉시 생성)"]
  A --> B --> C
```

> [!NOTE]
> `VK_PIPELINE_CREATE_FAIL_ON_PIPELINE_COMPILE_REQUIRED_BIT` 플래그를 사용하면 캐시에 없는 파이프라인 생성 시 즉시 실패를 반환받아 렌더링 루프 내부의 예기치 않은 스파이크(Jank)를 방지할 수 있다.

---

## 4. 커맨드 버퍼 기록 및 드로우 최적화

| 기법 | 설명 |
|------|------|
| **Secondary Command Buffer** | 워커 스레드별 커맨드 풀을 할당하여 드로우 명령을 병렬로 기록한 뒤, 메인 Primary 커맨드 버퍼에서 `vkCmdExecuteCommands`로 일괄 실행 |
| **Indirect Draw (`vkCmdDrawIndirect`)** | 드로우 파라미터를 GPU 버퍼에 저장하고 GPU에서 직접 드로우 호출을 발행하여 CPU 오버헤드 제거 |
| **Indirect Count (`vkCmdDrawIndirectCount`)** | 발행할 드로우 호출의 횟수 자체를 GPU(Compute Shader의 컬링 결과 등)에서 직접 결정 |
| **Device Generated Commands** | GPU 연산을 통해 커맨드 토큰 스트림을 직접 생성하고 실행 |
| **Conditional Rendering (`VK_EXT_conditional_rendering`)** | GPU 오클루전 쿼리 결과에 따라 특정 드로우 호출의 실행을 하드웨어 레벨에서 조건부 생략 |

```flowchart
flowchart TD
  A["CPU 스레드 1: Secondary CB 기록 (지형 렌더링)"]
  B["CPU 스레드 2: Secondary CB 기록 (오브젝트 렌더링)"]
  C["Primary CB: vkCmdExecuteCommands로 일괄 묶음"]
  D(["vkQueueSubmit: 단일 큐 제출"])
  A --> C
  B --> C
  C --> D
```

---

## 5. 고급 렌더링 확장 기능

### Fragment Shading Rate (VRS, `VK_KHR_fragment_shading_rate`)

화면 영역별로 프래그먼트 셰이더의 연산 해상도(예: 1x1, 2x2, 4x4)를 차등 적용한다.

1. **Pipeline FSR**: 드로우 호출 단위로 셰이딩 비율 지정
2. **Primitive FSR**: 정점/지오메트리 셰이더에서 프리미티브 단위로 비율 지정
3. **Attachment FSR**: 화면 영역별 비율을 저장한 이미지 맵을 어태치먼트로 전달

모션 블러가 적용된 영역이나 화면 외곽부, 또는 XR/VR 환경에서 시선 추적(Foveated Rendering)과 결합하여 중심부만 고해상도로 셰이딩함으로써 렌더링 부하를 대폭 절감한다.

### Tile Shading (`VK_QCOM_tile_shading`)

Qualcomm Adreno GPU의 TBDR 아키텍처에 특화된 기능이다. `vkCmdDispatchTileQCOM`/`vkCmdBeginTileRenderPassQCOM`/`vkCmdEndTileRenderPassQCOM` 명령으로 온칩 타일 메모리에 상주하는 어테치먼트에 직접 접근하여 타일 단위의 드로우·디스패치를 실행한다.

### Mesh Shading (`VK_EXT_mesh_shader`)

Task Shader와 Mesh Shader로 전통적인 입력 어셈블러(IA) 및 버텍스/인덱스 버퍼 파이프라인을 대체한다. CPU 개입 없이 GPU 내부에서 메시렛(Meshlet) 단위의 절두체 컬링, 뒷면 컬링, LOD 전환을 처리한다.

### Multiview (`VK_KHR_multiview`)

VR 양안 렌더링이나 캐스케이드 그림자 맵 생성을 **단일 렌더 패스**에서 처리한다. `viewMask`로 뷰 집합을 선언하고, `VK_DEPENDENCY_VIEW_LOCAL_BIT`로 뷰 간 의존성을 관리하여 뷰별 실행 겹침을 허용한다.

---

## 6. 핵심 최적화 체크리스트

- [ ] `VkPipelineCache`를 활용한 파이프라인 바이너리 디스크 직렬화 및 로드 구성
- [ ] 성능 민감 버퍼 및 이미지에 대한 전용 할당(`Dedicated Allocation`) 적용 여부 점검
- [ ] 프레임 단위 `VkDescriptorPool` 할당 및 일괄 리셋 구성
- [ ] Dynamic Uniform Buffer 또는 Push Constants를 통한 인스턴스별 데이터 바인딩 비용 절감
- [ ] GPU 기반 컬링 및 Indirect Draw(`vkCmdDrawIndirectCount`) 적용
- [ ] 파이프라인 배리어의 파이프라인 스테이지 마스크 및 접근 마스크 범위 최소화
- [ ] 렌더 패스 호환성(Render Pass Compatibility)을 유지하여 `VkFramebuffer` 및 파이프라인 재사용성 확보
- [ ] 워커 스레드별 전용 커맨드 풀을 통한 Secondary Command Buffer 병렬 기록 구성
