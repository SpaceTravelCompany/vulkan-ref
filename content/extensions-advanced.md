---
title: 고급 기능
slug: extensions-advanced
---

## 13. VK_EXT_host_image_copy — 호스트 이미지 복사

> **Vulkan 1.4 코어 승격**

### 용도

- 스테이징 버퍼 없이 **CPU → GPU 이미지 직접 복사**
- `memcpy`로 이미지 데이터 업로드 가능
- 텍스처 로딩 시 중간 버퍼 제거
- 초기화/로딩 시간 단축

### 사용 방법

```c
// 1. 기능 활성화
VkPhysicalDeviceHostImageCopyFeaturesEXT hostCopyFeatures = {
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_HOST_IMAGE_COPY_FEATURES_EXT,
    .hostImageCopy = VK_TRUE,
};

// 2. 이미지 생성 시 플래그
VkImageCreateInfo imageInfo = {
    // ...
    .usage = VK_IMAGE_USAGE_HOST_TRANSFER_BIT_EXT,  // 호스트 전송 지원
};

// 3. 호스트에서 직접 복사
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

- `VkDeviceMemory` 핸들로 직접 매핑 (버퍼/이미지 객체 불필요)
- `vkMapMemory2KHR` / `vkUnmapMemory2KHR` — 확장 가능한 구조체
- 호스트 접근 메모리를 더 유연하게 관리

### 사용 방법

```c
VkMemoryMapInfo mapInfo = {
    .sType = VK_STRUCTURE_TYPE_MEMORY_MAP_INFO,
    .memory = deviceMemory,
    .offset = 0,
    .size = VK_WHOLE_SIZE,
};
void* mapped;
vkMapMemory2KHR(device, &mapInfo, &mapped);

// ... 데이터 쓰기 ...

VkMemoryUnmapInfo unmapInfo = {
    .sType = VK_STRUCTURE_TYPE_MEMORY_UNMAP_INFO,
    .memory = deviceMemory,
};
vkUnmapMemory2KHR(device, &unmapInfo);
```

---

## 15. VK_EXT_device_generated_commands — 장치 생성 명령

> **GPU 사이드 명령 생성 | draw call 제로 오버헤드**

### 용도

- GPU가 직접 드로우/디스패치 명령을 생성
- CPU 개입 없이 간접 명령 버퍼 작성
- `vkCmdExecuteGeneratedCommandsEXT`로 GPU 생성 명령 실행
- 수만 개의 드로우 콜을 CPU 없이 처리
- D3D12 ExecuteIndirect와 동등

### 의존성

- `VK_KHR_buffer_device_address` 또는 Vulkan 1.2
- `VK_KHR_maintenance5` 또는 Vulkan 1.3

### 전처리(preprocess) 개념

Device Generated Commands는 앱이 만든 indirect input buffer를 그대로 실행하지 않는다. `VkIndirectCommandsLayoutEXT`의 token 배열을 기준으로 input buffer를 해석하고, 드라이버/GPU가 실행하기 쉬운 내부 형식으로 준비하는 단계가 필요할 수 있다. 이 준비 단계가 **preprocess**다.

흐름은 다음처럼 보면 된다:

```cmdstack
CPU 또는 GPU가 indirect input buffer 작성
---
preprocess
---
preprocessAddress에 드라이버 전용 중간 데이터 준비
---
vkCmdExecuteGeneratedCommandsEXT로 실제 draw/dispatch 실행
```

`preprocessAddress`의 내용과 레이아웃은 애플리케이션이 알 수 없는 opaque 데이터다. 앱이 직접 읽거나 수정하거나 다른 버퍼로 복사해서 재사용하면 안 된다.

### `isPreprocessed`

`vkCmdExecuteGeneratedCommandsEXT`의 두 번째 인자 `isPreprocessed`는 **이 `VkGeneratedCommandsInfoEXT`와 입력 버퍼 조합이 이미 GPU에서 전처리되었는지**를 알리는 값이다.

- `VK_FALSE`: 명시적 전처리를 따로 하지 않았다. execute 명령이 필요한 전처리를 내부적으로 처리한 뒤 generated commands를 실행한다.
- `VK_TRUE`: `vkCmdPreprocessGeneratedCommandsEXT`를 먼저 실행해두었다. execute 명령은 전처리 단계를 건너뛰고 `preprocessAddress`의 전처리 결과를 사용한다.

`VK_TRUE`를 쓰려면 조건이 빡빡하다:

- `vkCmdPreprocessGeneratedCommandsEXT`가 이 execute보다 먼저 GPU에서 실행되어 있어야 한다.
- preprocess 때 사용한 `VkGeneratedCommandsInfoEXT` 내용과 execute 때 사용하는 내용이 같아야 한다. 단, `preprocessAddress`는 예외다.
- preprocess가 참조한 indirect/input buffer 내용도 execute 때까지 같아야 한다.
- bound descriptor set, push constant, graphics/compute/ray tracing state도 preprocess 때와 execute 때가 일치해야 한다.
- `indirectCommandsLayout`은 `VK_INDIRECT_COMMANDS_LAYOUT_USAGE_EXPLICIT_PREPROCESS_BIT_EXT`로 만들어져 있어야 한다.

반대로 layout을 `VK_INDIRECT_COMMANDS_LAYOUT_USAGE_EXPLICIT_PREPROCESS_BIT_EXT`로 만들었다면 execute도 반드시 `isPreprocessed = VK_TRUE`로 호출해야 한다.

주의할 점: `isPreprocessed = VK_TRUE`여도 `vkCmdExecuteGeneratedCommandsEXT`가 `preprocessAddress`에 쓸 수 있다. 그래서 preprocess buffer는 DGC 관련 명령 외부에서 건드리지 않는 전용 scratch/cache 영역처럼 다뤄야 한다.

처음 구현할 때는 보통 `VK_FALSE` 경로가 단순하다. 전처리 비용을 실행 경로에서 분리하거나 같은 generated command 입력을 재사용하고 싶을 때 명시적 preprocess 경로를 쓴다.

### 사용 방법 (개요)

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

// 2. 명령 버퍼에 GPU 생성 명령 기록
VkGeneratedCommandsInfoEXT genInfo = {
    .sType = VK_STRUCTURE_TYPE_GENERATED_COMMANDS_INFO_EXT,
    .indirectCommandsLayout = layout,
    .indirectAddress = indirectBufferAddress,
    .indirectAddressSize = indirectSize,
    .preprocessAddress = preprocessBufferAddress,
    .preprocessSize = preprocessSize,
    // ...
};

// 단순 경로: execute가 필요한 전처리까지 처리
vkCmdExecuteGeneratedCommandsEXT(
    commandBuffer,
    VK_FALSE,     // isPreprocessed
    &genInfo
);
```

명시적으로 전처리를 분리하려면 layout 생성 시 `VK_INDIRECT_COMMANDS_LAYOUT_USAGE_EXPLICIT_PREPROCESS_BIT_EXT`를 사용하고, preprocess와 execute를 따로 기록한다.

```c
// layoutInfo.flags =
//     VK_INDIRECT_COMMANDS_LAYOUT_USAGE_EXPLICIT_PREPROCESS_BIT_EXT;

vkCmdPreprocessGeneratedCommandsEXT(
    commandBuffer,
    &genInfo,
    stateCommandBuffer
);

vkCmdExecuteGeneratedCommandsEXT(
    commandBuffer,
    VK_TRUE,      // 이미 preprocessAddress에 전처리 결과가 있음
    &genInfo
);
```

---

## 16. 레이 트레이싱 확장기능 세트

### VK_KHR_acceleration_structure + VK_KHR_ray_tracing_pipeline + VK_KHR_ray_query

> **하드웨어 RT 지원 GPU 필수 | NVIDIA Turing+, AMD RDNA2+, Intel Arc+**

### 용도

- **가속 구조체** (BLAS/TLAS) — 공간 색으로 빠른 레이 교차 테스트
- **레이 트레이싱 파이프라인** — RayGen, ClosestHit, Miss, Intersection 셰이더
- **레이 쿼리** — 기존 셰이더에서 레이 캐스트 (래스터+RT 하이브리드)
- 섀도우, 반사, GI, AO 등 RT 효과의 기반

### 3개 확장의 역할

| 확장기능 | 역할 |
|----------|------|
| `VK_KHR_acceleration_structure` | BLAS/TLAS 생성, 관리, 복사 |
| `VK_KHR_ray_tracing_pipeline` | RT 파이프라인, SBT, vkCmdTraceRays |
| `VK_KHR_ray_query` | 셰이더에서 `rayQueryEXT` 사용 |

### 의존성

```
VK_KHR_ray_tracing_pipeline
  ├── VK_KHR_acceleration_structure
  │     └── VK_KHR_buffer_device_address (또는 Vulkan 1.2)
  └── VK_KHR_spirv_1_4 (또는 Vulkan 1.2)

VK_KHR_ray_query
  └── VK_KHR_acceleration_structure
```

### 사용 방법 (개요)

```c
// 1. 가속 구조체 생성 (BLAS)
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

// 2. 빌드
vkCmdBuildAccelerationStructuresKHR(commandBuffer, 1, &buildInfo, &rangeInfo);

// 3. SBT (Shader Binding Table) 설정
VkStridedDeviceAddressRegionKHR rayGenSBT = {
    .deviceAddress = rayGenHandleAddress,
    .stride = shaderGroupHandleSize,
    .size = shaderGroupHandleSize,
};

// 4. 레이 트레이스 실행
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

> **Vulkan 1.3 코어 승격 | AI/ML 가속**

### 용도

- INT8 정수 도트 프로덕트 하드웨어 가속
- 양자화 신경망 추론에 필수
- 이미지 처리 (컨볼루션 등) 가속
- `OpSDot`, `OpUDot`, `OpSUDot` SPIR-V 명령

### 사용 방법 (GLSL)

```glsl
#extension GL_KHR_shader_integer_dot_product : require

void main() {
    u8vec4 a = ...;
    u8vec4 b = ...;
    uint result = dot(a, b);  // INT8 도트 프로덕트
}
```

---

## 18. VK_KHR_swapchain_maintenance1 — 스왑체인 유지보수

> **WSI 현대화 | Roadmap 2026 관련**

### 용도

- **Present Fence**: 프레젠트 완료 시 펜스 signal (안전한 리소스 해제)
- **동적 Present Mode**: 스왑체인 재생성 없이 프레젠트 모드 변경
- **스케일링/그래비티**: 이미지-표면 크기 불일치 시 동작 정의
- **지연 메모리 할당**: 스왑체인 메모리 할당을 첫 사용까지 지연
- **이미지 해제**: 프레젠티 없이 획득한 이미지 해제

### 사용 방법

```c
// Present Fence (프레젠티 완료 동기화)
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
// → presentFenceHandle가 signal되면 이미지 안전 해제 가능

// 이미지 해제 (프레젠티 없이)
VkReleaseSwapchainImagesInfoKHR releaseInfo = {
    .sType = VK_STRUCTURE_TYPE_RELEASE_SWAPCHAIN_IMAGES_INFO_KHR,
    .swapchain = swapchain,
    .imageIndexCount = 1,
    .pImageIndices = &imageIndex,
};
vkReleaseSwapchainImagesKHR(device, &releaseInfo);
```

---

## 19. VK_EXT_pipeline_creation_cache_control — 비동기 파이프라인 생성

> **Vulkan 1.3 코어 승격**

### 용도

- `VK_PIPELINE_CREATE_FAIL_ON_PIPELINE_COMPILE_REQUIRED_BIT` — 컴파일 필요 시 즉시 실패
- `VK_PIPELINE_CREATE_EARLY_RETURN_ON_FAILURE_BIT` — 조기 반환
- 파이프라인 캐시 미스 시 **프레임 드랍 방지**
- 백그라운드 컴파일 + 폴링 패턴 가능

### 사용 방법

```c
VkGraphicsPipelineCreateInfo pipelineInfo = {
    // ...
    .flags = VK_PIPELINE_CREATE_FAIL_ON_PIPELINE_COMPILE_REQUIRED_BIT,
};

VkResult result = vkCreateGraphicsPipelines(device, cache, 1, &pipelineInfo, NULL, &pipeline);
if (result == VK_PIPELINE_COMPILE_REQUIRED) {
    // 캐시 미스 → 백그라운드에서 비동기 컴파일
    // 다음 프레임에 다시 시도
}
```

---

## 20. Vulkan 1.4 셰이더 최적화 확장기능 묶음

> **Vulkan 1.4 코어 승격 | Roadmap 2024 필수**

### VK_KHR_shader_expect_assume

- 컴파일러에 **힌트** 제공 (`OpAssumeTrue`, `OpExpect`)
- 분기 예측, 루프 조건 최적화
- 런타임 동작 변화 없음

```glsl
#extension GL_EXT_expect_assume : require
void main() {
    uint idx = ...;
    assume(idx < MAX_OBJECTS);  // 컴파일러 최적화 힌트
}
```

### VK_KHR_shader_subgroup_rotate

- 서브그룹 내 데이터 로테이션 (`OpGroupNonUniformRotateKHR`)
- 웨이브프론트/서브그룹 내 효율적 데이터 교환

### VK_KHR_shader_float_controls2

- 부동소수점 연산 제어 강화
- FTZ, denorm 정밀도 세밀 제어

### VK_KHR_shader_maximal_reconvergence

- `OpGroupNonUniform*` 후 최대 재수렴 보장
- 다이버전트 제어 플로우 후 재수렴 최적화

### VK_KHR_shader_subgroup_uniform_control_flow

- 균일 제어 플로우에서 서브그룹 최적화 보장
- 모든 인보케이션이 같은 분기 경로 → 단일 실행

---
