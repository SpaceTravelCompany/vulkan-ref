---
title: Descriptor & Layout
slug: descriptors
---

## 소개

디스크립터(Descriptor)는 셰이더가 버퍼, 텍스처 이미지, 샘플러 등의 GPU 리소스에 간접적으로 접근할 수 있도록 연결하는 핸들이다. Vulkan은 셰이더에 리소스의 가상 주소를 직접 하드코딩하지 않고 디스크립터라는 불투명 핸들을 거치게 함으로써 다음과 같은 이점을 제공한다.

- **유연성**: 셰이더를 재컴파일하지 않고 디스크립터 세트만 교체하여 서로 다른 텍스처나 버퍼를 바인딩한다.
- **안전성**: GPU가 접근 가능한 리소스의 범위와 셰이더 스테이지별 가시성을 명시적으로 제어한다.
- **최적화**: 드라이버가 파이프라인 생성 시점에 리소스 바인딩 구조를 파악하여 하드웨어 파이프라인을 최적화한다.

---

## 1. 전체 구조 및 리소스 흐름

```flowchart
flowchart TD
  A["VkDescriptorSetLayout — 리소스 바인딩 규격 정의"]
  B["binding 0: uniform buffer (vertex)"]
  C["binding 1: combined image sampler (fragment)"]
  D["VkPipelineLayout — 파이프라인에 바인딩할 레이아웃 집합"]
  E["set 0: 위의 DescriptorSetLayout"]
  F["set 1: 머티리얼 전용 DescriptorSetLayout"]
  G["push constant range"]
  H["VkPipeline — 파이프라인 생성 시 파이프라인 레이아웃 등록"]
  I["VkDescriptorPool — 디스크립터 메모리 풀"]
  J["VkDescriptorSet — 실제 GPU 리소스를 가리키는 세트"]
  K["binding 0: 특정 VkBuffer + offset"]
  L["binding 1: 특정 VkImageView + VkSampler"]
  M(["vkCmdBindDescriptorSets() — 드로우 호출 전 바인딩"])
  A --> B
  A --> C
  A --> D
  D --> E
  D --> F
  D --> G
  D --> H
  H --> I
  I --> J
  J --> K
  J --> L
  J --> M
```

**디스크립터 파이프라인 순서:**

1. **레이아웃 정의**: 셰이더가 사용할 리소스 종류, 바인딩 번호, 대상 스테이지를 `VkDescriptorSetLayout`으로 선언.
2. **파이프라인 레이아웃 생성**: 여러 세트 레이아웃과 푸시 상수 범위를 묶어 `VkPipelineLayout` 생성.
3. **풀 생성**: 디스크립터 세트가 소비할 슬롯 메모리를 `VkDescriptorPool`에 사전 할당.
4. **세트 할당 및 갱신**: 풀에서 `VkDescriptorSet`을 할당한 뒤 실제 버퍼/이미지 정보를 `vkUpdateDescriptorSets`로 연결.
5. **커맨드 버퍼 바인딩**: 드로우나 디스패치 명령 전에 `vkCmdBindDescriptorSets`로 세트를 파이프라인에 연결.

---

## 2. `VkDescriptorSetLayout` — 바인딩 구조 정의

셰이더 내부의 `layout(binding = N)` 선언과 C++ 코드의 레이아웃 바인딩을 일치시켜야 한다.

```glsl
// 버텍스 셰이더
layout(set = 0, binding = 0) uniform CameraUBO {
    mat4 view;
    mat4 proj;
} camera;

// 프래그먼트 셰이더
layout(set = 0, binding = 1) uniform sampler2D diffuseMap;
layout(set = 0, binding = 2) uniform MaterialUBO {
    vec4 baseColor;
} material;
```

위 셰이더에 대응하는 `VkDescriptorSetLayout` 생성 코드:

```c
VkDescriptorSetLayoutBinding bindings[3] = {};

// binding 0: 카메라 UBO (버텍스 셰이더)
bindings[0].binding         = 0;
bindings[0].descriptorType  = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
bindings[0].descriptorCount = 1;
bindings[0].stageFlags      = VK_SHADER_STAGE_VERTEX_BIT;

// binding 1: 결합 이미지 샘플러 (프래그먼트 셰이더)
bindings[1].binding         = 1;
bindings[1].descriptorType  = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
bindings[1].descriptorCount = 1;
bindings[1].stageFlags      = VK_SHADER_STAGE_FRAGMENT_BIT;

// binding 2: 머티리얼 UBO (프래그먼트 셰이더)
bindings[2].binding         = 2;
bindings[2].descriptorType  = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
bindings[2].descriptorCount = 1;
bindings[2].stageFlags      = VK_SHADER_STAGE_FRAGMENT_BIT;

VkDescriptorSetLayoutCreateInfo layoutCI{};
layoutCI.sType        = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
layoutCI.bindingCount = 3;
layoutCI.pBindings    = bindings;

VkDescriptorSetLayout descriptorSetLayout;
vkCreateDescriptorSetLayout(device, &layoutCI, nullptr, &descriptorSetLayout);
```

**주요 필드 규격:**
- `binding`: 셰이더의 `binding = N` 번호와 일치해야 한다.
- `descriptorType`: UBO, SSBO, CombinedImageSampler, StorageImage 등 리소스 성격 지정.
- `descriptorCount`: 단일 리소스는 1, 텍스처 배열이나 런타임 배열은 해당 원소 수 지정.
- `stageFlags`: 리소스에 접근하는 셰이더 스테이지 마스크. 버텍스와 프래그먼트에서 동시 접근 시 비트 플래그를 결합한다.

---

## 3. `VkPipelineLayout` — 파이프라인 인터페이스 구성

파이프라인 생성 시 해당 파이프라인이 소비할 디스크립터 세트 레이아웃들과 푸시 상수의 범위를 선언한다.

```c
VkPipelineLayoutCreateInfo pipelineLayoutCI{};
pipelineLayoutCI.sType          = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
pipelineLayoutCI.setLayoutCount = 1;
pipelineLayoutCI.pSetLayouts    = &descriptorSetLayout;

// 푸시 상수 범위 선언 (선택 사항)
VkPushConstantRange pushConstant{};
pushConstant.stageFlags = VK_SHADER_STAGE_VERTEX_BIT;
pushConstant.offset     = 0;
pushConstant.size       = sizeof(glm::mat4);
pipelineLayoutCI.pushConstantRangeCount = 1;
pipelineLayoutCI.pPushConstantRanges    = &pushConstant;

VkPipelineLayout pipelineLayout;
vkCreatePipelineLayout(device, &pipelineLayoutCI, nullptr, &pipelineLayout);
```

**스펙 제약 사항:**
- `setLayoutCount`는 하드웨어 한계인 `VkPhysicalDeviceLimits::maxBoundDescriptorSets`(통상 4~8) 이하여야 한다.
- 각 파이프라인 스테이지에서 동시에 사용하는 디스크립터 개수는 `maxPerStageDescriptor*` 한도를 초과할 수 없다.
- 서로 다른 파이프라인 레이아웃이라도 디스크립터 세트 레이아웃 객체 자체는 재사용할 수 있다.

---

## 4. `VkDescriptorPool` — 디스크립터 메모리 관리

디스크립터 세트를 할당하려면 해당 디스크립터들을 담을 풀을 먼저 생성해야 한다. 풀 생성 시 최대 세트 수(`maxSets`)와 디스크립터 타입별 총 필요 개수(`VkDescriptorPoolSize`)를 사전에 선언한다.

```c
VkDescriptorPoolSize poolSizes[2] = {};
poolSizes[0].type            = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
poolSizes[0].descriptorCount = 3;  // UBO 총 3개 수용
poolSizes[1].type            = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
poolSizes[1].descriptorCount = 1;  // 텍스처 샘플러 1개 수용

VkDescriptorPoolCreateInfo poolCI{};
poolCI.sType         = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
poolCI.maxSets       = 1;  // 이 풀에서 할당할 최대 세트 수
poolCI.poolSizeCount = 2;
poolCI.pPoolSizes    = poolSizes;

VkDescriptorPool descriptorPool;
vkCreateDescriptorPool(device, &poolCI, nullptr, &descriptorPool);
```

**풀 관리 핵심 규칙:**
- **일괄 리셋**: 프레임 단위로 디스크립터를 생성하는 경우 `vkResetDescriptorPool`을 호출하여 풀 전체를 한 번에 초기화하는 방식이 가장 효율적이다.
- **개별 해제**: `vkFreeDescriptorSets`로 특정 세트만 개별 해제하려면 풀 생성 플래그에 `VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT`를 반드시 지정해야 한다. 플래그가 없으면 개별 해제가 금지되며 풀 리셋이나 풀 파괴 시에만 메모리가 회수된다.
- 풀이 파괴되면 해당 풀에서 할당된 모든 디스크립터 세트는 자동으로 무효화된다.
- **한도 확인**: `VkPhysicalDeviceLimits::maxDescriptorSet*` 시리즈(`maxDescriptorSetUniformBuffers`, `maxDescriptorSetSampledImages` 등)를 확인하여 풀 크기가 디바이스 한도를 초과하지 않도록 해야 한다.

---

## 5. `VkDescriptorSet` — 할당 및 리소스 바인딩

풀에서 세트를 할당받고, 실제 GPU 리소스 핸들(`VkBuffer`, `VkImageView`, `VkSampler`)을 세트의 슬롯에 기록한다.

```c
// 1. 디스크립터 세트 할당
VkDescriptorSetAllocateInfo allocInfo{};
allocInfo.sType              = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
allocInfo.descriptorPool     = descriptorPool;
allocInfo.descriptorSetCount = 1;
allocInfo.pSetLayouts        = &descriptorSetLayout;

VkDescriptorSet descriptorSet;
vkAllocateDescriptorSets(device, &allocInfo, &descriptorSet);

// 2. 바인딩 0: UBO 버퍼 정보 설정
VkDescriptorBufferInfo bufferInfo{};
bufferInfo.buffer = uniformBuffer;
bufferInfo.offset = 0;
bufferInfo.range  = sizeof(CameraUBO);

VkWriteDescriptorSet writeUBO{};
writeUBO.sType           = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
writeUBO.dstSet          = descriptorSet;
writeUBO.dstBinding      = 0;
writeUBO.descriptorCount = 1;
writeUBO.descriptorType  = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
writeUBO.pBufferInfo     = &bufferInfo;

// 3. 바인딩 1: 텍스처 및 샘플러 정보 설정
VkDescriptorImageInfo imageInfo{};
imageInfo.imageLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
imageInfo.imageView   = textureImageView;
imageInfo.sampler     = textureSampler;

VkWriteDescriptorSet writeSampler{};
writeSampler.sType           = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
writeSampler.dstSet          = descriptorSet;
writeSampler.dstBinding      = 1;
writeSampler.descriptorCount = 1;
writeSampler.descriptorType  = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
writeSampler.pImageInfo      = &imageInfo;

// 4. 일괄 업데이트 호출
VkWriteDescriptorSet writes[] = { writeUBO, writeSampler };
vkUpdateDescriptorSets(device, 2, writes, 0, nullptr);
```

> **스레드 안전성 주의** `vkAllocateDescriptorSets`, `vkFreeDescriptorSets`, `vkResetDescriptorPool`은 동일한 풀 객체에 대해 외부 동기화(External Synchronization)를 요구한다. 멀티스레드 환경에서는 스레드마다 별도의 풀을 두거나 락으로 보호해야 한다.

---

## 6. 파이프라인 바인딩 및 렌더링

커맨드 버퍼에 렌더링 명령을 기록할 때 파이프라인 레이아웃과 디스크립터 세트를 연결한다.

```c
vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, graphicsPipeline);

// 디스크립터 세트 바인딩
vkCmdBindDescriptorSets(cmd,
    VK_PIPELINE_BIND_POINT_GRAPHICS,
    pipelineLayout,
    0,               // firstSet: 0번 세트부터 바인딩
    1,               // descriptorSetCount
    &descriptorSet,  // 바인딩할 세트 배열
    0, nullptr);     // 동적 오프셋(Dynamic Offset) 없음

vkCmdDraw(cmd, vertexCount, 1, 0, 0);
```

---

## 7. 다중 세트 분리 패턴

렌더링 파이프라인의 갱신 주기(Frequency)에 따라 세트를 분리하면 드로우 호출 간 불필요한 상태 갱신을 최소화할 수 있다.

```glsl
// set 0: 프레임 전역 데이터 (카메라, 환경광 등 - 프레임당 1회 바인딩)
layout(set = 0, binding = 0) uniform FrameData { mat4 viewProj; } frame;

// set 1: 머티리얼별 텍스처 (머티리얼 전환 시 바인딩)
layout(set = 1, binding = 0) uniform sampler2D diffuseTex;

// set 2: 오브젝트별 동적 데이터 (오브젝트마다 바인딩)
layout(set = 2, binding = 0) uniform ObjectData { mat4 model; } object;
```

```c
// 프레임 시작 시 전역 세트 1회 바인딩
vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 0, 1, &frameSet, 0, nullptr);

// 머티리얼 변경 시
vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 1, 1, &materialSet, 0, nullptr);

// 드로우마다 오브젝트 세트 교체
vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, layout, 2, 1, &objectSet, 0, nullptr);
vkCmdDraw(cmd, ...);
```

---

## 8. Update-After-Bind (`VK_EXT_descriptor_indexing`, Vulkan 1.2 코어)

기본 모델에서는 커맨드 버퍼에 `vkCmdBindDescriptorSets`를 기록한 이후 해당 디스크립터 세트의 내용을 수정하면 이미 기록된 커맨드 버퍼가 무효화되거나 GPU 실행 중 데이터 경합이 발생한다.

**Update-After-Bind** 플래그를 설정하면 커맨드 버퍼 기록 후 큐 제출 전까지 디스크립터 슬롯의 내용을 갱신할 수 있으며, 제출 시점의 최신 상태가 GPU에 반영된다. 이를 통해 거대한 텍스처 배열을 미리 등록해 두고 인덱스로 접근하는 바인드리스(Bindless) 렌더링을 구현할 수 있다.

**필수 활성화 항목 (4단계):**

1. **디바이스 기능**: `VkPhysicalDeviceDescriptorIndexingFeatures`에서 해당 디스크립터 타입의 `descriptorBinding*UpdateAfterBind` 활성화.
2. **세트 레이아웃 플래그**: `VkDescriptorSetLayoutCreateInfo::flags`에 `VK_DESCRIPTOR_SET_LAYOUT_CREATE_UPDATE_AFTER_BIND_POOL_BIT` 지정.
3. **바인딩 플래그**: `VkDescriptorSetLayoutBindingFlagsCreateInfo`의 pNext 체인을 통해 해당 바인딩에 `VK_DESCRIPTOR_BINDING_UPDATE_AFTER_BIND_BIT` 지정.
4. **풀 플래그**: `VkDescriptorPoolCreateInfo::flags`에 `VK_DESCRIPTOR_POOL_CREATE_UPDATE_AFTER_BIND_BIT` 지정.

```c
VkDescriptorSetLayoutBinding binding{};
binding.binding         = 0;
binding.descriptorType  = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
binding.descriptorCount = 1024;  // 거대 텍스처 배열
binding.stageFlags      = VK_SHADER_STAGE_FRAGMENT_BIT;

VkDescriptorBindingFlags flags = VK_DESCRIPTOR_BINDING_UPDATE_AFTER_BIND_BIT
                               | VK_DESCRIPTOR_BINDING_PARTIALLY_BOUND_BIT;

VkDescriptorSetLayoutBindingFlagsCreateInfo flagsCI{};
flagsCI.sType         = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_BINDING_FLAGS_CREATE_INFO;
flagsCI.bindingCount  = 1;
flagsCI.pBindingFlags = &flags;

VkDescriptorSetLayoutCreateInfo layoutCI{};
layoutCI.sType        = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
layoutCI.pNext        = &flagsCI;
layoutCI.flags        = VK_DESCRIPTOR_SET_LAYOUT_CREATE_UPDATE_AFTER_BIND_POOL_BIT;
layoutCI.bindingCount = 1;
layoutCI.pBindings    = &binding;

VkDescriptorSetLayout bindlessLayout;
vkCreateDescriptorSetLayout(device, &layoutCI, nullptr, &bindlessLayout);
```

> [!NOTE]
> 여기서 말하는 "갱신"은 `VkBuffer`, `VkImageView`, `VkSampler` 등 디스크립터 슬롯의 **연결 대상**을 바꾸는 것이다. 이미 연결된 버퍼 내부 데이터를 `vkMapMemory`나 복사 명령으로 수정하는 것은 별도의 메모리 동기화 문제이며, 디스크립터 갱신과 무관하다.

> [!WARNING]
> Update-After-Bind를 사용하면 드라이버가 더 유연한 디스크립터 추적을 수행해야 하므로 **성능 trade-off**가 발생할 수 있다. 바인드리스 패턴의 편의성과 GPU 오버헤드를 비교하여 도입 여부를 판단해야 한다.

---

## 9. Descriptor Set Layout 재사용

동일한 레이아웃을 공유하는 여러 디스크립터 세트를 만들 수 있다. 예를 들어 머티리얼마다 다른 텍스처를 바인딩하지만 레이아웃 구조(UBO 1개 + 샘플러 1개)가 동일한 경우, 하나의 `VkDescriptorSetLayout`으로 여러 세트를 할당하고 드로우 호출 시 세트만 교체하면 된다.

```c
// 하나의 layout으로 여러 세트 할당
allocInfo.pSetLayouts = &sameLayout;
vkAllocateDescriptorSets(device, &allocInfo, &setA);
// setA에 객체 A의 버퍼/텍스처 연결

vkAllocateDescriptorSets(device, &allocInfo, &setB);
// setB에 객체 B의 버퍼/텍스처 연결

// 드로우 시 세트만 교체
vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS,
    pipelineLayout, 0, 1, &setA, 0, nullptr);
vkCmdDraw(cmd, ...);

vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS,
    pipelineLayout, 0, 1, &setB, 0, nullptr);
vkCmdDraw(cmd, ...);
```

> **관련 확장**: `VK_EXT_descriptor_buffer`(Vulkan 1.4 코어)는 디스크립터 풀/세트 대신 GPU 메모리 버퍼에 직접 디스크립터를 기록하는 방식이다. `uniform-and-storage-buffers` 토픽 §11 참고.
