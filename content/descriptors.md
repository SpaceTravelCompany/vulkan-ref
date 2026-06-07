---
title: Descriptor & Layout
slug: descriptors
---

## 왜 Descriptor가 필요한가?

셰이더는 버퍼, 이미지, 샘플러 같은 리소스에 접근해야 한다. 그런데 Vulkan에서는 "이 버퍼를 써"라고 직접 주소값을 넘기지 않는다. 대신 **Descriptor**라는 "중간 테이블"을 거친다.

이 방식의 장점:
- **유연성**: 같은 셰이더라도 Descriptor만 바꾸면 다른 리소스를 쓸 수 있다
- **안전성**: GPU가 접근 가능한 리소스를 명시적으로 관리
- **성능**: 드라이버가 미리 바인딩 정보를 알고 있어서 최적화 가능

---

---

## 1. 큰 그림

```cmdstack
VkDescriptorSetLayout ← 이런 바인딩이 필요하다
binding 0: uniform buffer (vertex shader)
binding 1: combined image sampler (frag)
---
VkPipelineLayout ← 파이프라인에 이 layout을 쓴다
set 0 layout: 위의 DescriptorSetLayout
set 1 layout: 다른 DescriptorSetLayout
push constant range
---
VkPipeline ← 셰이더 코드에서 binding 접근 · 파이프라인 생성 시 넘김
---
VkDescriptorPool ← descriptor를 할당할 풀
---
VkDescriptorSet ← 실제 GPU 리소스를 담은 set
binding 0: 특정 VkBuffer + offset
binding 1: 특정 VkImageView + VkSampler
---
vkCmdBindDescriptorSets() ← 드로우 시 전달
```

결국 순서는 다음과 같다:

1. **Layout 정의**: 셰이더가 "어떤 종류의 리소스를 몇 개, 어느 스테이지에서 쓸지"를 레이아웃으로 정의
2. **Pool 생성**: 실제 descriptor 메모리를 풀에서 할당
3. **Set 할당**: Layout을 기반으로 실제 descriptor set을 할당
4. **Set 업데이트**: 할당된 set에 실제 buffer/image/sampler를 연결
5. **Set 바인딩**: 드로우/디스패치 전에 set을 파이프라인에 바인딩

---

---

## 2. VkDescriptorSetLayout ("어떤 바인딩이 필요한가")

셰이더에서 사용하는 변수들을 **binding point** 단위로 정의한다.

> **초보자 용어**: **Binding Point** = 셰이더에서 리소스에 접근하는 "슬롯 번호". `layout(binding = 0)`이면 0번 슬롯에 연결된 리소스를 쓴다는 뜻.

예를 들어 다음과 같은 GLSL 셰이더가 있다고 가정하자:

```glsl
// vertex shader
layout(set = 0, binding = 0) uniform UniformBufferObject {
    mat4 model;
    mat4 view;
    mat4 proj;
} ubo;

// fragment shader
layout(set = 0, binding = 1) uniform sampler2D texSampler;
layout(set = 0, binding = 2) uniform UniformFragment {
    vec4 color;
} uboFrag;
```

이에 대응하는 C 레이아웃:

```c
VkDescriptorSetLayoutBinding bindings[3] = {};

// binding 0: UBO (vertex shader)
bindings[0].binding = 0;
bindings[0].descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
bindings[0].descriptorCount = 1;
bindings[0].stageFlags = VK_SHADER_STAGE_VERTEX_BIT;

// binding 1: combined image sampler (fragment shader)
bindings[1].binding = 1;
bindings[1].descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
bindings[1].descriptorCount = 1;
bindings[1].stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT;

// binding 2: UBO (fragment shader)
bindings[2].binding = 2;
bindings[2].descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
bindings[2].descriptorCount = 1;
bindings[2].stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT;

VkDescriptorSetLayoutCreateInfo dslCI{};
dslCI.bindingCount = 3;
dslCI.pBindings = bindings;
vkCreateDescriptorSetLayout(device, &dslCI, nullptr, &descriptorSetLayout);
```

**핵심 파라미터:**

- `binding`: 셰이더 layout과 일치해야 함
- `descriptorType`: UBO, SSBO, CombinedImageSampler, StorageImage 등
- `descriptorCount`: 배열이면 개수
- `stageFlags`: 어느 셰이더 스테이지에서 접근하는지. 같은 binding을 여러 스테이지가 공유할 수 있음

**Vulkan 1.2 / VK_EXT_descriptor_indexing**부터는 **Update-After-Bind**와 **Partially-Bound** 등이 추가되어, 레이아웃을 더 유연하게 구성할 수 있다.

---

---

## 3. VkPipelineLayout ("파이프라인에 layout 연결")

파이프라인을 생성할 때, 어떤 descriptor set layout을 사용할지 전달한다.

> **용도** 파이프라인은 "이 셰이더를 쓸 건데, 이런 레이아웃으로 리소스를 넘길 거야"라고 미리 선언하는 것이다. GPU는 이 정보를 보고 셰이더 컴파일 최적화를 진행한다.

```c
VkPipelineLayoutCreateInfo plCI{};
plCI.setLayoutCount = 1;
plCI.pSetLayouts = &descriptorSetLayout;  // 위에서 만든 layout

// push constant도 여기서 정의
VkPushConstantRange pushConstant{};
pushConstant.stageFlags = VK_SHADER_STAGE_VERTEX_BIT;
pushConstant.offset = 0;
pushConstant.size = sizeof(PushConstants);
plCI.pushConstantRangeCount = 1;
plCI.pPushConstantRanges = &pushConstant;

vkCreatePipelineLayout(device, &plCI, nullptr, &pipelineLayout);
```

**제약 (스펙 발췌):**

- `setLayoutCount` ≤ `VkPhysicalDeviceLimits::maxBoundDescriptorSets` (보통 4~8)
- 각 스테이지별 sampler/UBO/SSBO/StorageImage 개수는 `maxPerStageDescriptor*` 한도를 초과할 수 없음
- 연결된 모든 set layout의 **binding 번호가 중복되어선 안 됨** (set 간에는 중복 가능)

**set layout과 pipeline layout의 관계:**

- DescriptorSetLayout은 "binding 구조"만 정의한다. 어떤 VkBuffer/VkImageView를 연결할지는 나중에 descriptor set에서 결정한다.
- PipelineLayout은 "파이프라인이 이 layout들을 사용한다"고 등록하는 역할이다.
- 하나의 DescriptorSetLayout을 여러 PipelineLayout에서 재사용할 수 있다.

---

---

## 4. VkDescriptorPool ("descriptor 메모리")

실제 descriptor set을 할당하려면 먼저 descriptor pool이 필요하다.

> **비유**: Descriptor Pool은 "책상"이고, Descriptor Set은 그 위에 놓인 "작업 공간"이다. 풀을 먼저 만들어야 그 안에서 작업 공간을 할당받을 수 있다.

```c
VkDescriptorPoolSize poolSizes[2] = {};
poolSizes[0].type = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
poolSizes[0].descriptorCount = 3;     // UBO 3개를 할당할 수 있어야 함
poolSizes[1].type = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
poolSizes[1].descriptorCount = 1;

VkDescriptorPoolCreateInfo poolCI{};
poolCI.maxSets = 1;                    // 이 풀에서 최대 1개의 set을 할당
poolCI.poolSizeCount = 2;
poolCI.pPoolSizes = poolSizes;
vkCreateDescriptorPool(device, &poolCI, nullptr, &descriptorPool);
```

**팁:**

- 프레임당 별도 pool = `vkResetDescriptorPool()`로 쉽게 리셋 가능 (별도 플래그 불필요)
- 개별 descriptor set을 `vkFreeDescriptorSets()`로 해제하려면 `VK_DESCRIPTOR_POOL_CREATE_FREE_DESCRIPTOR_SET_BIT` 필요
- 대량 할당은 pool 하나에 몰아서 = `vkResetDescriptorPool`로 한 번에 리셋
- `VkPhysicalDeviceLimits::maxDescriptorSet*` 시리즈 제한 확인 필수

---

---

## 5. VkDescriptorSet ("실제 리소스 연결")

pool에서 set을 할당하고, 실제 리소스(buffer / image / sampler)를 연결한다.

> **핵심 개념**: Layout이 "어떤 슬롯이 있는지"였다면, Set은 "그 슬롯에 실제로 무엇을 꽂을지"를 정의한다. 같은 Layout으로 여러 Set을 만들어서, 드로우마다 Set만 바꿔 끼울 수 있다.

```c
// 할당
VkDescriptorSetAllocateInfo allocInfo{};
allocInfo.descriptorPool = descriptorPool;
allocInfo.descriptorSetCount = 1;
allocInfo.pSetLayouts = &descriptorSetLayout;
vkAllocateDescriptorSets(device, &allocInfo, &descriptorSet);

// 업데이트: UBO 연결
VkDescriptorBufferInfo bufferInfo{};
bufferInfo.buffer = uniformBuffer;
bufferInfo.offset = 0;
bufferInfo.range = sizeof(UniformBufferObject);

VkWriteDescriptorSet writeUBO{};
writeUBO.dstSet = descriptorSet;
writeUBO.dstBinding = 0;
writeUBO.descriptorCount = 1;
writeUBO.descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
writeUBO.pBufferInfo = &bufferInfo;

// 업데이트: sampler + image view 연결 (combined image sampler)
VkDescriptorImageInfo imageInfo{};
imageInfo.imageLayout = VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL;
imageInfo.imageView = textureImageView;
imageInfo.sampler = textureSampler;

VkWriteDescriptorSet writeSampler{};
writeSampler.dstSet = descriptorSet;
writeSampler.dstBinding = 1;
writeSampler.descriptorCount = 1;
writeSampler.descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
writeSampler.pImageInfo = &imageInfo;

// 한 번에 적용
VkWriteDescriptorSet writes[] = { writeUBO, writeSampler };
vkUpdateDescriptorSets(device, 2, writes, 0, nullptr);
```

**주의:** `vkUpdateDescriptorSets`는 **pool이 externally synchronized**되어야 하므로, 여러 스레드에서 같은 pool의 set을 동시에 업데이트하면 안 된다.

---

---

## 6. 바인딩과 드로우

이제 실제로 그릴 때 Descriptor Set을 파이프라인에 연결한다.

```c
// 그리기 전에 descriptor set을 바인딩
vkCmdBindDescriptorSets(cmdBuffer,
    VK_PIPELINE_BIND_POINT_GRAPHICS, // graphics or compute
    pipelineLayout,                   // 어떤 pipeline layout과 연결된 set인지
    0,                                // firstSet: set 0부터
    1,                                // descriptorSetCount
    &descriptorSet,                   // 실제 set
    0, nullptr);                      // dynamic offset

vkCmdDraw(cmdBuffer, vertexCount, 1, 0, 0);
```

여러 set을 사용하는 경우 `firstSet`으로 시작 set 번호를 지정한다.

---

---

## 7. 여러 Set / 여러 Binding 예제

```c
// 셰이더 측
layout(set = 0, binding = 0) uniform sampler2D gBufferColor;
layout(set = 1, binding = 0) uniform sampler2D gBufferNormal;
layout(set = 1, binding = 1) uniform LightBlock { vec4 lights[64]; };

// C++ 측: set 0과 set 1을 각각 만들고, 한 번에 바인딩
VkDescriptorSet sets[] = { gbufferSet, lightingSet };
vkCmdBindDescriptorSets(cmdBuffer, VK_PIPELINE_BIND_POINT_GRAPHICS,
    pipelineLayout, 0, 2, sets, 0, nullptr);
```

---

---

## 8. Update-After-Bind (Vulkan 1.2 / VK_EXT_descriptor_indexing)

기본 규칙은 "bind 이후 업데이트가 조용히 무시된다"가 아니다. 일반 descriptor binding에서는 command buffer에 set을 bind한 뒤 그 set의 descriptor를 다시 쓰면, 이미 기록된 command buffer가 invalid 될 수 있고 GPU가 아직 쓰는 중인 set도 건드리면 안 된다.

그래서 기본 모델은 이렇게 생각하면 된다:

- `vkCmdBindDescriptorSets`로 set을 command buffer에 기록한다
- 그 command buffer가 실행을 끝낼 때까지, 해당 set의 descriptor 내용은 고정된 것으로 취급한다
- 다른 리소스로 바꾸고 싶으면 보통 다른 descriptor set을 쓰거나, GPU 사용이 끝난 뒤 업데이트한다

> **헷갈리기 쉬운 점** 여기서 말하는 업데이트는 `VkBuffer`, `VkImageView`, `VkSampler` 같은 descriptor 슬롯의 연결 대상을 바꾸는 것이다. 이미 연결된 buffer 안의 데이터를 mapped memory나 copy 명령으로 바꾸는 건 별도의 메모리 동기화 문제다.

`Update-After-Bind`는 이 규칙을 완화하는 옵션이다. 해당 binding에 `VK_DESCRIPTOR_BINDING_UPDATE_AFTER_BIND_BIT`를 주면, set을 command buffer에 bind한 뒤 submit 전에 descriptor를 다시 써도 command buffer가 invalid 되지 않고, submit 시점에는 가장 최근에 쓴 descriptor가 사용된다.

설정은 네 군데가 맞아야 한다:

- 디바이스 feature: descriptor 타입에 맞는 `descriptorBinding*UpdateAfterBind` 활성화
- set layout: `VK_DESCRIPTOR_SET_LAYOUT_CREATE_UPDATE_AFTER_BIND_POOL_BIT`
- binding flag: `VK_DESCRIPTOR_BINDING_UPDATE_AFTER_BIND_BIT`
- descriptor pool: `VK_DESCRIPTOR_POOL_CREATE_UPDATE_AFTER_BIND_BIT`

```c
VkDescriptorSetLayoutBinding binding{};
binding.binding = 0;
binding.descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER;
binding.descriptorCount = 1024;
binding.stageFlags = VK_SHADER_STAGE_FRAGMENT_BIT;

VkDescriptorBindingFlags bindingFlags[] = {
    VK_DESCRIPTOR_BINDING_UPDATE_AFTER_BIND_BIT,
};

VkDescriptorSetLayoutBindingFlagsCreateInfo bindingFlagsCI{};
bindingFlagsCI.sType =
    VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_BINDING_FLAGS_CREATE_INFO;
bindingFlagsCI.bindingCount = 1;
bindingFlagsCI.pBindingFlags = bindingFlags;

// layout 생성 시 update-after-bind pool flag와 binding flag를 같이 설정
VkDescriptorSetLayoutCreateInfo dslCI{};
dslCI.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
dslCI.pNext = &bindingFlagsCI;
dslCI.flags = VK_DESCRIPTOR_SET_LAYOUT_CREATE_UPDATE_AFTER_BIND_POOL_BIT;
dslCI.bindingCount = 1;
dslCI.pBindings = &binding;

// pool 생성 시에도 update-after-bind flag 설정
VkDescriptorPoolCreateInfo poolCI{};
poolCI.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
poolCI.flags = VK_DESCRIPTOR_POOL_CREATE_UPDATE_AFTER_BIND_BIT;
```

이를 사용하면 매번 새 set을 할당하지 않고, 큰 descriptor 배열의 일부 슬롯만 나중에 채우거나 교체하는 바인드리스 패턴을 만들 수 있다. 단, GPU가 이미 실행 중인 작업에서 같은 descriptor를 읽고 있을 수 있으므로 frame-in-flight, fence, timeline semaphore 같은 동기화 설계는 여전히 필요하다. 드라이버가 더 유연한 descriptor 추적을 해야 해서 성능 trade-off도 생길 수 있다.

---

---

## 9. Descriptor Set Layout의 재사용

동일한 layout을 공유하는 여러 descriptor set을 만들 수 있다. 예를 들어:

```c
// 하나의 layout으로 여러 UBO + 텍스처 조합을 만듦
VkDescriptorSetLayout sameLayout;
vkCreateDescriptorSetLayout(device, &dslCI, nullptr, &sameLayout);

// 객체 A (layout 기반으로 set 할당)
VkDescriptorSet setA;
allocInfo.pSetLayouts = &sameLayout;
vkAllocateDescriptorSets(device, &allocInfo, &setA);
// setA에 객체 A의 buffer 연결

// 객체 B (같은 layout)
VkDescriptorSet setB;
vkAllocateDescriptorSets(device, &allocInfo, &setB);
// setB에 객체 B의 buffer 연결

// 그릴 때마다 set만 교체
vkCmdBindDescriptorSets(..., 1, &setA, ...);
vkCmdDraw(...);
vkCmdBindDescriptorSets(..., 1, &setB, ...);
vkCmdDraw(...);
```
