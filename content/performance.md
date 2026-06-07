---
title: 성능 최적화
slug: performance
---

## 소개

Vulkan은 **명시적 제어**로 CPU·GPU 오버헤드를 최소화하도록 설계됐다. 대신 렌더 패스, 동기화, 디스크립터, 메모리까지 직접 관리해야 한다. 이 글은 Vulkan에서 실전으로 쓰이는 최적화 기법을 정리한다.

> **용어 정리**
> - **Render Pass**: 렌더링 대상(컬러·깊이 등)과 서브패스 의존성을 정의하는 단위
> - **Descriptor**: 셰이더가 읽는 버퍼·텍스처·샘플러 바인딩
> - **Pipeline Barrier**: GPU 작업 간 메모리·실행 순서 동기화

---

---

## 3. 디스크립터 최적화

디스크립터 바인딩은 CPU 비용이 큰 편이다. 할당·바인딩 횟수를 줄이는 것이 목표다.

| 기법 | 설명 |
|------|------|
| **Descriptor Pool 리셋** | 프레임마다 풀 리셋, 고정 크기 풀로 할당 비용 감소 |
| **Dynamic UBO/SSBO** | 하나의 디스크립터 + 오프셋으로 여러 오브젝트 |
| **Descriptor Buffer (EXT)** | 버퍼에 디스크립터 직접 기록 |
| **Push Descriptor** | `vkCmdPushDescriptorSet`으로 할당 없이 푸시 |
| **Push Constants** | 장치의 `maxPushConstantsSize` 안에 들어가는 작은 상수를 셰이더에 직접 전달 |
| **Inline Uniform Block** | 디스크립터 세트에 유니폼 데이터 포함 |

**실전**: 작고 자주 바뀌는 값(오브젝트 인덱스, 머티리얼 ID)은 **Push Constants**, 프레임·카메라 데이터는 **Dynamic UBO**가 흔한 조합이다.

---

---

## 4. 메모리 할당

| 방식 | 용도 |
|------|------|
| **Dedicated Allocation** | 중요 리소스에 전용 메모리 (`vkGet*MemoryRequirements2`로 권장 여부 확인) |
| **Suballocation** | 여러 리소스를 하나의 `VkDeviceMemory`에 할당 (`bufferImageGranularity` 정렬 주의) |
| **Sparse Binding** | 대형 텍스처·버퍼에 필요한 페이지만 물리 메모리 바인딩 |

메모리 타입 우선순위: **`DEVICE_LOCAL`** (GPU 전용) → 필요 시 **`HOST_VISIBLE`** (스테이징)

---

---

## 5. 파이프라인 캐시 / 셰이더

파이프라인 생성은 비용이 크다. **캐시·라이브러리·식별자**로 재컴파일을 피한다.

- **`VkPipelineCache`**: 종료 시 `vkGetPipelineCacheData`로 디스크 저장 → 다음 실행 시 초기 데이터로 로드
- **Pipeline Library**: 파이프라인 일부를 라이브러리로 분리·재사용
- **Shader Module Identifier**: SPIR-V 대신 식별자로 파이프라인 조회
- **Graphics Pipeline Library**: 정적/동적 부분 분리 → 상태 변경 시 전체 재컴파일 방지
- **Shader Objects**: 파이프라인 없이 셰이더 스테이지만 바인딩

```cmdstack
첫 실행 ← SPIR-V 컴파일 · 느림
---
Pipeline Cache 저장 ← vkGetPipelineCacheData
---
이후 실행 ← 캐시 히트 · 빠름
```

`VK_PIPELINE_CREATE_FAIL_ON_PIPELINE_COMPILE_REQUIRED_BIT`로 런타임 컴파일 블로킹을 방지할 수 있다.

---

---

## 6. 커맨드 버퍼

| 기법 | 설명 |
|------|------|
| **Secondary CB** | 스레드별 커맨드 풀에서 병렬 기록 후 Primary CB에서 실행 |
| **Indirect Draw** | `vkCmdDrawIndirect`, `vkCmdDrawIndexedIndirect` |
| **Indirect Count** | draw 개수도 GPU가 결정 |
| **Device Generated Commands** | GPU가 커맨드 버퍼 직접 생성 |
| **Conditional Rendering** | 오클루전 쿼리 결과로 draw 스킵 |

```cmdstack
CPU Thread 1 ← Secondary CB (지형)
CPU Thread 2 ← Secondary CB (오브젝트)
---
Primary CB ← ExecuteCommands × 2
---
Queue Submit
```

---

---

## 7. 고급 기능

### Fragment Shading Rate (VRS)

`VK_KHR_fragment_shading_rate`로 영역별 셰이딩 밀도를 조절한다.

1. **Pipeline FSR** — draw call 단위
2. **Primitive FSR** — 셰이더에서 프리미티브 단위
3. **Attachment FSR** — 프레임버퍼 이미지 영역별

XR/VR에서 시선 추적과 결합하면 중심부만 고해상도로 그릴 수 있다.

### Tile Shading (VK_QCOM_tile_shading)

Adreno TBDR을 직접 활용: 타일별 draw/dispatch, 타일 첨부 직접 접근, `vkCmdDispatchTileQCOM`.

### Mesh Shading (VK_EXT_mesh_shader)

Task Shader가 메슐릿 단위 컬링·LOD를 결정하고, Mesh Shader가 정점·프리미티브를 생성한다. 전통 IA·인덱스 버퍼 파이프라인을 우회한다.

### Multiview (VK_KHR_multiview)

VR 양안을 **단일 렌더 패스**에서 처리. View Mask와 `VK_DEPENDENCY_VIEW_LOCAL_BIT`로 뷰 간 의존성 관리.

---

---

## 8. 최적화 체크리스트

- Pipeline Cache 디스크 저장/불러오기
- Dedicated Allocation 권장 리소스 확인
- Descriptor Pool 프레임별 리셋
- Dynamic Uniform Buffer로 오브젝트별 데이터
- Push Constants로 작은 상수 전달
- Indirect Drawing + GPU 컬링
- Pipeline Barrier 최소화 (stage mask 좁게)
- Render Pass 호환 Framebuffer 재사용
- Secondary Command Buffer 멀티스레딩
