---
title: 고급 기능
slug: extensions-advanced
---

## 13. VK_EXT_host_image_copy — 호스트 이미지 복사

> **Vulkan 1.4 코어 승격**

### 용도

- 중간 스테이징 버퍼(Staging Buffer) 할당 없이 호스트(CPU) 메모리에서 디바이스(GPU) 이미지로 직접 데이터 전송
- 커맨드 버퍼 기록 및 GPU 큐 제출 없이 호스트 API(`vkCopyMemoryToImageEXT`) 호출만으로 텍스처 데이터 업로드 완료
- 스테이징 버퍼 생성 및 동기화 배리어 제거로 파이프라인 초기화 및 비동기 에셋 로딩 시간 단축

### 사용 방법

```c
// 1. 기능 활성화
VkPhysicalDeviceHostImageCopyFeaturesEXT hostCopyFeatures = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_HOST_IMAGE_COPY_FEATURES_EXT,
    .hostImageCopy = VK_TRUE,
};

// 2. 이미지 생성 시 호스트 전송 플래그 지정
VkImageCreateInfo imageInfo = {
    // ...
    .usage = VK_IMAGE_USAGE_HOST_TRANSFER_BIT_EXT,  // 호스트 직접 전송 허용
};

// 3. 호스트에서 직접 픽셀 데이터 복사
VkMemoryToImageCopy region = {
    .sType = VK_STRUCTURE_TYPE_MEMORY_TO_IMAGE_COPY,
    .pHostPointer = pixelData,
    .imageSubresource = { .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT, /* ... */ },
    .imageOffset = {0, 0, 0},
    .imageExtent = {width, height, 1},
};

VkCopyMemoryToImageInfo copyInfo = {
    .sType = VK_STRUCTURE_TYPE_COPY_MEMORY_TO_IMAGE_INFO,
    .dstImage = myImage,
    .dstImageLayout = VK_IMAGE_LAYOUT_GENERAL,
    .regionCount = 1,
    .pRegions = &region,
};
vkCopyMemoryToImageEXT(device, &copyInfo);
```

---

## 14. VK_KHR_map_memory2 — 메모리 매핑2

> **Vulkan 1.4 코어 승격 | Roadmap 2024 필수**

### 용도

- `pNext` 체인을 지원하는 확장 가능한 구조체(`VkMemoryMapInfo` / KHR 별칭 `VkMemoryMapInfoKHR`)를 도입하여 메모리 매핑 API 현대화
- Vulkan 1.0의 고정 인자 함수 구조를 대체하여 향후 플래그 추가 및 서브리소스 매핑 확장 지원
- 호스트 가시(Host Visible) 메모리 매핑 및 해제 작업의 안전성과 일관성 강화

### 사용 방법

```c
VkMemoryMapInfo mapInfo = {
    .sType = VK_STRUCTURE_TYPE_MEMORY_MAP_INFO,
    .memory = deviceMemory,
    .offset = 0,
    .size = VK_WHOLE_SIZE,
};
void* mapped;
vkMapMemory2(device, &mapInfo, &mapped);  // KHR 별칭: vkMapMemory2KHR

// ... 호스트 메모리 쓰기 ...

VkMemoryUnmapInfo unmapInfo = {
    .sType = VK_STRUCTURE_TYPE_MEMORY_UNMAP_INFO,
    .memory = deviceMemory,
};
vkUnmapMemory2(device, &unmapInfo);  // KHR 별칭: vkUnmapMemory2KHR
```

---

## 15. VK_EXT_device_generated_commands — 장치 생성 명령

> **GPU 주도 명령 생성 | 드로우 콜 오버헤드 최소화**

### 용도

- CPU 개입 없이 GPU 컴퓨트 셰이더가 간접 드로우 및 디스패치 명령 버퍼를 직접 생성
- 파이프라인 바인딩, 푸시 상수 갱신, 드로우/디스패치 명령을 GPU 타임라인에서 일괄 처리
- 수만 개의 드로우 콜을 단일 디스패치 루프로 처리하여 CPU 병목을 근본적으로 제거
- Direct3D 12의 `ExecuteIndirect`와 대등한 GPU 주도 렌더링 파이프라인 구현

### 의존성

- `VK_KHR_buffer_device_address` (또는 Vulkan 1.2 이상)
- `VK_KHR_maintenance5` (또는 Vulkan 1.3 이상)

### 전처리(Preprocess) 메커니즘

Device Generated Commands(DGC)는 애플리케이션이 작성한 간접 입력 버퍼(`indirectAddress`)를 드라이버와 하드웨어가 실행하기 적합한 내부 명령 형식으로 변환하는 **전처리(Preprocess)** 단계를 거친다.

```flowchart
flowchart TD
  A["CPU 또는 GPU가 indirect input buffer 작성"]
  B["preprocess"]
  C["preprocessAddress에 드라이버 전용 중간 데이터 준비"]
  D(["vkCmdExecuteGeneratedCommandsEXT로 실제 draw/dispatch 실행"])
  A --> B --> C --> D
```

`preprocessAddress`에 기록되는 데이터는 드라이버 전용의 불투명(opaque) 데이터다. 애플리케이션이 해당 메모리 영역을 직접 읽거나 수정해서는 안 되며, DGC 전용 스크래치 메모리로 취급해야 한다.

### `isPreprocessed` 매개변수 제어

`vkCmdExecuteGeneratedCommandsEXT`의 두 번째 매개변수인 `isPreprocessed`는 사전 전처리 완료 여부를 명시한다.

- `VK_FALSE`: 명시적 전처리 호출 없이 실행 시점에 드라이버가 전처리와 명령 실행을 일괄 처리한다. 구조가 단순하여 초기 도입에 적합하다.
- `VK_TRUE`: 사전에 `vkCmdPreprocessGeneratedCommandsEXT`를 호출하여 전처리를 마친 상태에서 명령을 실행한다. 전처리 비용을 비동기 큐로 분리하거나 동일한 간접 명령 입력을 여러 번 재사용할 때 성능상 유리하다.

`isPreprocessed = VK_TRUE` 설정 시 다음 조건을 충족해야 한다:

1. `VkIndirectCommandsLayoutEXT` 생성 시 `VK_INDIRECT_COMMANDS_LAYOUT_USAGE_EXPLICIT_PREPROCESS_BIT_EXT` 플래그를 반드시 포함해야 한다.
2. 반대로 레이아웃에 `EXPLICIT_PREPROCESS_BIT_EXT`가 있으면 `vkCmdExecuteGeneratedCommandsEXT`의 `isPreprocessed`도 `VK_TRUE`여야 한다.
3. 실행 전 동일 GPU 타임라인에서 `vkCmdPreprocessGeneratedCommandsEXT`가 선행 실행되어야 한다.
4. 전처리 시점과 실행 시점의 `VkGeneratedCommandsInfoEXT` 설정(단, `preprocessAddress` 제외), 참조 버퍼 데이터, 바인딩된 디스크립터 세트 및 파이프라인 상태가 동일하게 유지되어야 한다.
5. `preprocessAddress`에 기록된 전처리 데이터를 다른 버퍼로 복사하여 재사용하면 안 된다. 전처리 결과는 생성 시점의 커맨드 버퍼·바인딩 상태에 종속된다.

### 사용 방법

```c
// 1. 간접 명령 레이아웃 정의
VkIndirectCommandsLayoutCreateInfoEXT layoutInfo = {
    .sType = VK_STRUCTURE_TYPE_INDIRECT_COMMANDS_LAYOUT_CREATE_INFO_EXT,
    .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS,
    .tokenCount = 2,
    .pTokens = (VkIndirectCommandsLayoutTokenEXT[]){
        { .type = VK_INDIRECT_COMMANDS_TOKEN_TYPE_SHADER_GROUP_EXT, /* ... */ },
        { .type = VK_INDIRECT_COMMANDS_TOKEN_TYPE_DRAW_EXT, /* ... */ },
    },
};

// 2. 생성 명령 실행 정보 설정
VkGeneratedCommandsInfoEXT genInfo = {
    .sType = VK_STRUCTURE_TYPE_GENERATED_COMMANDS_INFO_EXT,
    .indirectCommandsLayout = layout,
    .indirectAddress = indirectBufferAddress,
    .indirectAddressSize = indirectSize,
    .preprocessAddress = preprocessBufferAddress,
    .preprocessSize = preprocessSize,
    // ...
};

// 단일 실행 경로: 실행 호출 내에서 전처리를 일괄 처리
vkCmdExecuteGeneratedCommandsEXT(
    commandBuffer,
    VK_FALSE,     // isPreprocessed
    &genInfo
);

// 명시적 전처리 분리 경로:
// layoutInfo.flags에 VK_INDIRECT_COMMANDS_LAYOUT_USAGE_EXPLICIT_PREPROCESS_BIT_EXT 필요
vkCmdPreprocessGeneratedCommandsEXT(
    commandBuffer,
    &genInfo,
    stateCommandBuffer
);

vkCmdExecuteGeneratedCommandsEXT(
    commandBuffer,
    VK_TRUE,      // 사전 전처리 완료 플래그
    &genInfo
);
```

---

## 16. 레이 트레이싱 확장 세트

### VK_KHR_acceleration_structure + VK_KHR_ray_tracing_pipeline + VK_KHR_ray_query

> **하드웨어 RT 지원 필수 | NVIDIA Turing+, AMD RDNA2+, Intel Arc+**

### 용도

- **가속 구조체(Acceleration Structure)**: 바운딩 볼륨 계층(BVH)을 GPU 메모리에 구축하여 광선-삼각형 교차 검사를 하드웨어 수준에서 가속 (BLAS/TLAS 2단계 계층 구조)
- **레이 트레이싱 파이프라인(Ray Tracing Pipeline)**: 광선 생성(RayGen), 최근접 교차(Closest Hit), 미스(Miss), 교차(Intersection), 임의 교차(Any Hit) 등 전용 셰이더 스테이지로 구성된 독립 파이프라인
- **레이 쿼리(Ray Query)**: 기존 래스터화 셰이더(VS/FS/CS) 내부에서 인라인으로 광선을 추적하는 기능 (하이브리드 렌더링에 적합)
- 실시간 그림자, 반사, 전역 조명(GI), 앰비언트 오클루전(AO) 구현의 핵심

### 3대 핵심 확장의 역할

| 확장 명칭 | 주요 역할 |
|-----------|-----------|
| `VK_KHR_acceleration_structure` | BLAS 및 TLAS 가속 구조체 생성, 메모리 관리, 빌드, 압축, 복사 |
| `VK_KHR_ray_tracing_pipeline` | 레이 트레이싱 전용 파이프라인 생성, 셰이더 바인딩 테이블(SBT), `vkCmdTraceRaysKHR` 실행 |
| `VK_KHR_ray_query` | 셰이더 내부에서 `rayQueryEXT` 객체를 통한 인라인 광선 교차 검사 |

### 의존성 관계

```
VK_KHR_ray_tracing_pipeline
  ├── VK_KHR_acceleration_structure
  │     ├── VK_KHR_buffer_device_address (또는 Vulkan 1.2 이상)
  │     ├── VK_KHR_deferred_host_operations (비동기 AS 빌드용)
  │     └── VK_EXT_descriptor_indexing (바인드리스 SBT/Ray Query에 권장)
  └── VK_KHR_spirv_1_4 (또는 Vulkan 1.2 이상)

VK_KHR_ray_query
  ├── VK_KHR_acceleration_structure (위 의존성 포함)
  └── VK_KHR_spirv_1_4 (또는 Vulkan 1.2 이상)
```

### 사용 방법

```c
// 1. 하위 가속 구조체(BLAS) 지오메트리 정의
VkAccelerationStructureGeometryKHR geometry = {
    .sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_KHR,
    .geometryType = VK_GEOMETRY_TYPE_TRIANGLES_KHR,
    .geometry.triangles = {
        .sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_TRIANGLES_DATA_KHR,
        .vertexData = { .deviceAddress = vertexBufferAddress },
        .vertexFormat = VK_FORMAT_R32G32B32_SFLOAT,
        .vertexStride = sizeof(Vertex),
        .maxVertex = vertexCount,
        .indexData = { .deviceAddress = indexBufferAddress },
        .indexType = VK_INDEX_TYPE_UINT32,
        .transformData = { .deviceAddress = transformAddress },
    },
    .flags = VK_GEOMETRY_OPAQUE_BIT_KHR,
};

// 2. 가속 구조체 빌드 기록
vkCmdBuildAccelerationStructuresKHR(commandBuffer, 1, &buildInfo, &rangeInfo);

// 3. 셰이더 바인딩 테이블(SBT) 메모리 영역 설정
VkStridedDeviceAddressRegionKHR rayGenSBT = {
    .deviceAddress = rayGenHandleAddress,
    .stride = shaderGroupHandleSize,
    .size = shaderGroupHandleSize,
};

// 4. 광선 추적 실행
vkCmdTraceRaysKHR(
    commandBuffer,
    &rayGenSBT,
    &missSBT,
    &hitSBT,
    &callableSBT,
    width, height, 1
);
```

---

## 17. VK_KHR_shader_integer_dot_product — 정수 도트 프로덕트

> **Vulkan 1.3 코어 승격 | AI/ML 및 이미지 프로세싱 가속**

### 용도

- INT8 및 8비트/16비트 정수 벡터 내적(Dot Product) 연산의 하드웨어 가속
- 신경망 양자화 모델(INT8 Quantized Neural Network)의 고속 추론에 필수
- 콘볼루션 필터링 등 정수 기반 이미지 필터 처리 가속
- `OpSDot`, `OpUDot`, `OpSUDot` 등 SPIR-V 정수 내적 명령 매핑

### 사용 방법 (GLSL)

```glsl
#extension GL_EXT_integer_dot_product : require
#extension GL_EXT_shader_explicit_arithmetic_types_int8 : require  // u8vec4 사용 시 필요

void main() {
    u8vec4 a = u8vec4(1, 2, 3, 4);
    u8vec4 b = u8vec4(5, 6, 7, 8);
    uint result = dotEXT(a, b);  // INT8 정수 벡터 내적 하드웨어 연산
}
```

---

## 18. VK_KHR_swapchain_maintenance1 — 스왑체인 유지보수

> **WSI 현대화 | Roadmap 2026 연계**

### 용도

- **Present Fence**: 화면 프레젠트 작업 완료 시점을 펜스로 신호받아 프레임 버퍼 및 리소스 안전 해제
- **동적 Present Mode**: 스왑체인을 재생성하지 않고도 V-Sync 모드(FIFO ↔ Mailbox 등) 동적 변경
- **스케일링 및 그래비티**: 윈도우 표면과 스왑체인 이미지 크기 불일치 시의 배율 및 정렬 방식 정의
- **지연 메모리 할당**: 스왑체인 이미지 메모리 할당을 첫 렌더링 시점까지 지연하여 초기화 지연 완화
- **미표시 이미지 해제**: 화면에 프레젠트하지 않고 획득(Acquire)한 이미지를 즉시 해제

### 사용 방법

```c
// 1. Present Fence를 통한 프레젠트 완료 동기화
VkSwapchainPresentFenceInfoKHR presentFence = {
    .sType = VK_STRUCTURE_TYPE_SWAPCHAIN_PRESENT_FENCE_INFO_KHR,
    .swapchainCount = 1,
    .pFences = &presentFenceHandle,
};

VkPresentInfoKHR presentInfo = {
    .sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR,
    .pNext = &presentFence,
    // ...
};
vkQueuePresentKHR(queue, &presentInfo);
// presentFenceHandle 신호 수신 시 이전 프레임 리소스 안전 해제 가능

// 2. 프레젠트하지 않은 이미지 반환
VkReleaseSwapchainImagesInfoKHR releaseInfo = {
    .sType = VK_STRUCTURE_TYPE_RELEASE_SWAPCHAIN_IMAGES_INFO_KHR,
    .swapchain = swapchain,
    .imageIndexCount = 1,
    .pImageIndices = &imageIndex,
};
vkReleaseSwapchainImagesKHR(device, &releaseInfo);
```

---

## 19. VK_EXT_pipeline_creation_cache_control — 파이프라인 생성 캐시 제어

> **Vulkan 1.3 코어 승격**

### 용도

- `VK_PIPELINE_CREATE_FAIL_ON_PIPELINE_COMPILE_REQUIRED_BIT`: 셰이더 캐시 미스로 컴파일이 필요할 경우 파이프라인 생성을 즉시 중단하고 실패 반환
- `VK_PIPELINE_CREATE_EARLY_RETURN_ON_FAILURE_BIT`: 컴파일 실패 시 즉시 제어권 반환
- 메인 렌더링 루프에서 캐시 미스로 인한 스터터링(프레임 드랍) 방지
- 백그라운드 워커 스레드 컴파일 및 폴링 패턴의 표준 인터페이스 제공

### 사용 방법

```c
VkGraphicsPipelineCreateInfo pipelineInfo = {
    // ...
    .flags = VK_PIPELINE_CREATE_FAIL_ON_PIPELINE_COMPILE_REQUIRED_BIT,
};

VkResult result = vkCreateGraphicsPipelines(device, cache, 1, &pipelineInfo, NULL, &pipeline);
if (result == VK_PIPELINE_COMPILE_REQUIRED) {
    // 캐시 미스 감지: 메인 스레드 멈춤 없이 백그라운드 컴파일 스레드로 작업 위임
    // 준비 완료 전까지는 폴백 셰이더 사용 또는 다음 프레임에 재시도
}
```

---

## 20. Vulkan 1.4 셰이더 최적화 확장 묶음

> **일부 1.4 코어 승격 | Roadmap 2024 권장**  
> `VK_KHR_shader_expect_assume`, `VK_KHR_shader_float_controls2` 등은 1.4 코어 승격.  
> `VK_KHR_shader_maximal_reconvergence`, `VK_KHR_shader_subgroup_uniform_control_flow`는 미승격(KHR 유지).

### VK_KHR_shader_expect_assume

- 셰이더 컴파일러에 런타임 값의 범위나 조건을 힌트로 전달 (`OpAssumeTrueKHR`, `OpExpectKHR`)
- 셰이더 분기 예측 최적화 및 루프 언롤링 유도 (런타임 제어 흐름은 변경되지 않음)

```glsl
#extension GL_EXT_expect_assume : require
void main() {
    uint idx = ...;
    assume(idx < MAX_OBJECTS);  // 인덱스 상한 힌트 제공으로 경계 검사 최적화 유도
}
```

### VK_KHR_shader_subgroup_rotate

- 서브그룹 내 인보케이션 간 데이터 회전 교환 (`OpGroupNonUniformRotateKHR`)
- 공유 메모리(LDS) 경유 없이 웨이브프론트 내부에서 고속 데이터 셔플 수행

### VK_KHR_shader_float_controls2

- 부동소수점 연산 모드 제어 강화
- 비정규화 수(Denorm) 보존, FTZ(Flush-to-Zero), 반올림 모드를 셰이더 단위로 정밀 제어

### VK_KHR_shader_maximal_reconvergence

- 분기문 실행 후 서브그룹 인보케이션이 최대 범위로 재수렴(Reconvergence)하도록 명세상 보장
- 다이버전트(Divergent) 제어 흐름 이후 록스텝(Lock-step) 병렬 실행 효율 복원

### VK_KHR_shader_subgroup_uniform_control_flow

- 동적으로 균일한 제어 흐름 구간에서 서브그룹 내 모든 활성 인보케이션이 단일 경로로 실행됨을 보장
- 제어 흐름 분기로 인한 비효율적인 마스킹 실행 방지
