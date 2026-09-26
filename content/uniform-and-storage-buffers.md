---
title: Uniform & Storage Buffer
slug: uniform-and-storage-buffers
---

## 소개

균일 버퍼(Uniform Buffer, UBO)와 저장 버퍼(Storage Buffer, SSBO)는 셰이더에 버퍼 메모리를 공급하는 대표적인 디스크립터 유형이다. UBO는 소량의 읽기 전용 상수에 최적화되어 있고, SSBO는 대용량 구조화 데이터의 임의 읽기/쓰기 및 아토믹(Atomic) 연산을 지원한다.

> **용어 정리**
> - **UBO (Uniform Buffer)**: 셰이더 읽기 전용. 카메라 뷰-투영 행렬, 전역 조명 파라미터 등 변하지 않는 상수에 사용.
> - **SSBO (Storage Buffer)**: 셰이더 읽기/쓰기/아토믹 연산 지원. 파티클 시뮬레이션, GPU 기반 컬링 데이터 등에 사용.
> - **Dynamic Offset**: `vkCmdBindDescriptorSets` 호출 시 추가 바이트 오프셋을 전달하여 동일 세트로 버퍼의 다른 영역을 가리키는 방식.
> - **Range**: `VkDescriptorBufferInfo::range`로 지정하는 바이트 크기. `VK_WHOLE_SIZE` 사용 시 디바이스 최대 한도 이내여야 함.
> - **Texel Buffer**: 버퍼 데이터를 텍셀 포맷으로 해석하여 1D 텍스처처럼 샘플링하거나 로드/스토어하는 버퍼(`VkBufferView` 필요).

이 문서는 UBO, SSBO, 동적 오프셋, 텍셀 버퍼 및 인라인 균일 블록의 동작 원리와 실무 제약 사항을 정리한다.

---

## 1. 전체 흐름

```flowchart
flowchart TD
  A["VkBuffer 생성 및 메모리 바인딩"]
  B["VkDescriptorSetLayoutBinding 선언"]
  C["VkDescriptorPool 생성"]
  D(["vkAllocateDescriptorSets — 세트 할당"])
  E["VkDescriptorBufferInfo { buffer, offset, range } 설정"]
  F(["vkUpdateDescriptorSets — 세트에 버퍼 연결"])
  G(["vkCmdBindDescriptorSets — 파이프라인에 바인딩 (+ dynamic offset)"])
  H["셰이더: uniform UBO { ... } 또는 buffer SSBO { ... }"]
  A --> B --> C --> D --> E --> F --> G --> H
```

**핵심 요약:**
- 하부 리소스는 동일한 `VkBuffer`이며, 디스크립터 레이아웃 선언에 따라 하드웨어 인터페이스와 캐싱 정책이 결정된다.
- UBO와 SSBO의 오프셋은 각각 `minUniformBufferOffsetAlignment`, `minStorageBufferOffsetAlignment`(통상 256바이트)의 배수여야 한다.

---

## 2. 버퍼 디스크립터 유형 비교

| 디스크립터 유형 | 요구 버퍼 usage | 셰이더 접근 권한 | 특징 및 제약 |
|----------------|----------------|----------------|-------------|
| `UNIFORM_BUFFER` | `UNIFORM_BUFFER_BIT` | 읽기 전용 | `maxUniformBufferRange` 한계 (보통 64 KB), 하드웨어 상수 캐시 활용 |
| `UNIFORM_BUFFER_DYNAMIC` | `UNIFORM_BUFFER_BIT` | 읽기 전용 | 바인딩 시 동적 오프셋 가산 |
| `STORAGE_BUFFER` | `STORAGE_BUFFER_BIT` | 읽기 / 쓰기 / 아토믹 | 기가바이트 단위 지원. 프래그먼트 셰이더에서 쓰기/아토믹은 `fragmentStoresAndAtomics` 피처 필요 |
| `STORAGE_BUFFER_DYNAMIC` | `STORAGE_BUFFER_BIT` | 읽기 / 쓰기 / 아토믹 | 바인딩 시 동적 오프셋 가산. 프래그먼트 쓰기/아토믹은 동일 피처 필요 |
| `UNIFORM_TEXEL_BUFFER` | `UNIFORM_TEXEL_BUFFER_BIT` | 포맷 변환 읽기 | `VkBufferView` 경유, 1D 텍셀 배열 |
| `STORAGE_TEXEL_BUFFER` | `STORAGE_TEXEL_BUFFER_BIT` | 포맷 변환 읽기/쓰기 | `VkBufferView` 경유, 이미지 로드/스토어 |
| `INLINE_UNIFORM_BLOCK` | 버퍼 불필요 | 읽기 전용 | 디스크립터 세트 내부 메모리에 직접 기록 |

---

## 3. `VkDescriptorBufferInfo` — 디스크립터 버퍼 정보

```c
typedef struct VkDescriptorBufferInfo {
    VkBuffer     buffer;
    VkDeviceSize offset;
    VkDeviceSize range;
} VkDescriptorBufferInfo;
```

### 3.1. 오프셋 정렬 제약

단일 버퍼를 여러 서브 영역으로 쪼개서 쓸 때 `offset`은 반드시 하드웨어 정렬 규격을 만족해야 한다.

- UBO 오프셋 정렬: `VkPhysicalDeviceLimits::minUniformBufferOffsetAlignment` (대부분 256바이트).
- SSBO 오프셋 정렬: `VkPhysicalDeviceLimits::minStorageBufferOffsetAlignment` (대부분 256바이트 또는 그 이하).
- 정렬 배수에 맞추지 않으면 밸리데이션 오류가 발생하거나 정의되지 않은 메모리를 읽게 된다.

### 3.2. 범위(Range) 한계

- UBO 단일 범위: `VkPhysicalDeviceLimits::maxUniformBufferRange` (통상 64 KB).
- SSBO 단일 범위: `VkPhysicalDeviceLimits::maxStorageBufferRange` (통상 1 GB ~ $2^{32}-1$).
- 거대한 버퍼에서 서브할당하는 경우 `range`에 `VK_WHOLE_SIZE`를 지정하면 버퍼 잔여 크기가 `maxUniformBufferRange`를 초과하여 오류가 발생할 수 있으므로, 실제 구조체 크기에 맞춘 명시적 크기를 지정해야 한다.

---

## 4. 디스크립터 갱신 (`vkUpdateDescriptorSets`)

```c
VkDescriptorBufferInfo bufferInfo{};
bufferInfo.buffer = uboBuffer;
bufferInfo.offset = 0;
bufferInfo.range  = sizeof(CameraData);

VkWriteDescriptorSet write{};
write.sType           = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
write.dstSet          = descriptorSet;
write.dstBinding      = 0;
write.dstArrayElement = 0;
write.descriptorCount = 1;
write.descriptorType  = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
write.pBufferInfo     = &bufferInfo;

vkUpdateDescriptorSets(device, 1, &write, 0, nullptr);
```

---

## 5. 동적 오프셋 (Dynamic UBO / SSBO)

단일 디스크립터 세트로 수백 개의 드로우마다 다른 데이터를 공급할 때 사용한다. 디스크립터 세트 업데이트를 매번 호출하지 않고 드로우 시점에 시작 오프셋만 교체한다.

```c
// 1. 디스크립터 갱신 시에는 기본 슬롯 크기(256B 정렬 단위)만 등록
VkDescriptorBufferInfo dynInfo{};
dynInfo.buffer = materialBuffer;
dynInfo.offset = 0;
dynInfo.range  = sizeof(MaterialBlock);  // 256바이트 정렬 맞춤

VkWriteDescriptorSet write{};
write.sType           = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
write.dstSet          = materialSet;
write.dstBinding      = 0;
write.descriptorCount = 1;
write.descriptorType  = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC;
write.pBufferInfo     = &dynInfo;
vkUpdateDescriptorSets(device, 1, &write, 0, nullptr);

// 2. 드로우 루프에서 동적 오프셋만 넘겨 바인딩
for (uint32_t i = 0; i < drawCount; ++i) {
    uint32_t dynamicOffset = i * 256;  // 반드시 정렬의 배수
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS,
        pipelineLayout, 0, 1, &materialSet, 1, &dynamicOffset);
    vkCmdDraw(cmd, vertexCount, 1, 0, 0);
}
```

> **주의 사항**
> - `vkCmdBindDescriptorSets`에 전달하는 `dynamicOffsetCount`는 해당 세트 레이아웃에 포함된 모든 동적 디스크립터(Dynamic UBO + Dynamic SSBO)의 총 개수와 정확히 일치해야 한다. 오프셋 배열의 순서는 바인딩 번호 순서를 따른다.
> - 실제 셰이더가 보는 오프셋은 `VkDescriptorBufferInfo::offset`(base) + `pDynamicOffsets[i]`이다. 유효 오프셋 + `range` ≤ 버퍼 크기여야 한다(VUID-…-pDescriptorSets-01979).
> - `range = VK_WHOLE_SIZE`면 동적 오프셋은 반드시 0이어야 한다(VUID-…-06715).

---

## 6. 텍셀 버퍼 (Texel Buffer)

버퍼 메모리를 텍셀 단위로 정형화하여 셰이더의 `samplerBuffer` 또는 `imageBuffer` 인터페이스로 노출한다.

```c
VkBufferViewCreateInfo bvci{};
bvci.sType  = VK_STRUCTURE_TYPE_BUFFER_VIEW_CREATE_INFO;
bvci.buffer = storageBuffer;
bvci.format = VK_FORMAT_R32G32B32A32_SFLOAT;
bvci.offset = 0;
bvci.range  = VK_WHOLE_SIZE;

VkBufferView bufferView;
vkCreateBufferView(device, &bvci, nullptr, &bufferView);

// 디스크립터 갱신 시 pTexelBufferView에 전달 (pBufferInfo 아님)
VkWriteDescriptorSet write{};
write.sType            = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
write.dstSet           = descriptorSet;
write.dstBinding       = 0;
write.descriptorCount  = 1;
write.descriptorType   = VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER;
write.pTexelBufferView = &bufferView;

vkUpdateDescriptorSets(device, 1, &write, 0, nullptr);
```

```glsl
// GLSL 셰이더
layout(set = 0, binding = 0) uniform imageBuffer myTexels;

void main() {
    vec4 val = imageLoad(myTexels, int(gl_GlobalInvocationID.x));
    imageStore(myTexels, int(gl_GlobalInvocationID.x), val * 2.0);
}
```

---

## 7. 인라인 균일 블록 (Inline Uniform Block)

Vulkan 1.3 코어(`VK_EXT_inline_uniform_block`)에 포함된 기능으로, 별도의 `VkBuffer` 없이 **디스크립터 세트의 저장 공간에 상수를 직접 패킹**한다.

```c
struct InlineBlock { glm::mat4 mvp; glm::vec4 tint; } inlineData;

VkWriteDescriptorSetInlineUniformBlock iub{};
iub.sType    = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET_INLINE_UNIFORM_BLOCK;
iub.dataSize = sizeof(InlineBlock);
iub.pData    = &inlineData;

VkWriteDescriptorSet write{};
write.sType           = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
write.pNext           = &iub;
write.dstSet          = descriptorSet;
write.dstBinding      = 0;
write.descriptorCount = sizeof(InlineBlock);  // 주의: 개수가 아닌 바이트 크기!
write.descriptorType  = VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK;

vkUpdateDescriptorSets(device, 1, &write, 0, nullptr);
```

**푸시 상수와의 비교:**
- 푸시 상수는 128~256바이트 한계가 있지만, 인라인 균일 블록은 바인딩당 최대 4 KB(`maxInlineUniformBlockSize`)까지 수용한다.
- 푸시 상수는 드로우마다 커맨드 버퍼에 기록해야 하지만, 인라인 블록은 디스크립터 세트에 저장되어 여러 드로우 호출 간 재사용이 가능하다.

---

## 8. 디스크립터 풀 크기 산정

```c
VkDescriptorPoolSize poolSizes[] = {
    { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER,         16 },
    { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC,  8 },
    { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,          8 },
    { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC,  4 },
    { VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER,    4 },
    { VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK,  1024 }  // 인라인 블록은 바이트 단위 합계
};

VkDescriptorPoolCreateInfo poolCI{};
poolCI.sType         = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
poolCI.maxSets       = 32;
poolCI.poolSizeCount = (uint32_t)std::size(poolSizes);
poolCI.pPoolSizes    = poolSizes;

VkDescriptorPool pool;
vkCreateDescriptorPool(device, &poolCI, nullptr, &pool);
```

---

## 9. 자주 발생하는 오류 점검 목록

### 9.1. 정렬 및 오프셋 오류

- [ ] UBO의 `offset`이 `minUniformBufferOffsetAlignment` 배수를 위반 (VUID-VkDescriptorBufferInfo-offset-00327).
- [ ] SSBO의 `offset`이 `minStorageBufferOffsetAlignment` 배수를 위반 (VUID-VkDescriptorBufferInfo-offset-00328).
- [ ] UBO의 `offset + range`가 버퍼 크기를 초과 (VUID-VkDescriptorBufferInfo-offset-00332).
- [ ] SSBO의 `offset + range`가 버퍼 크기를 초과 (VUID-VkDescriptorBufferInfo-offset-00333).
- [ ] 동적 오프셋 배열의 크기가 세트에 포함된 동적 디스크립터 총합과 일치하지 않음.
- [ ] 여러 동적 바인딩을 넘길 때 바인딩 번호 순서와 오프셋 배열 인덱스 순서가 꼬이는 문제.

### 9.2. 용량 및 범위 오류

- [ ] 단일 UBO의 `range`가 `maxUniformBufferRange`(64 KB)를 초과.
- [ ] 거대한 단일 버퍼에서 `range = VK_WHOLE_SIZE`를 지정하여 최대 범위 제약 위반.
- [ ] SSBO의 64비트 주소 지정이 필요한 크기인데 `shader64BitIndexing` 기능을 활성화하지 않음.

### 9.3. 텍셀 및 인라인 블록 오류

- [ ] 텍셀 버퍼 갱신 시 `pTexelBufferView` 대신 `pBufferInfo`를 전달하는 실수.
- [ ] `VkBufferView` 생성 시 포맷이 해당 텍셀 버퍼 usage를 지원하지 않음 (VUID-VkBufferViewCreateInfo-format-08778).
- [ ] 인라인 균일 블록의 `descriptorCount`에 1(개수)을 넣는 실수 (반드시 구조체 바이트 크기 전달).

---

## 10. 디스크립터 업데이트 템플릿 (`VkDescriptorUpdateTemplate`)

`vkUpdateDescriptorSets`의 오버헤드를 줄이기 위해 디스크립터 세트의 메모리 레이아웃을 템플릿으로 사전 정의하고, 단 한 번의 호출로 C++ 메모리를 복사하듯 세트를 갱신한다.

```c
VkDescriptorUpdateTemplateEntry entries[] = {
    { 0, 0, 1, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, offsetof(FrameData, uboInfo), sizeof(VkDescriptorBufferInfo) },
    { 1, 0, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, offsetof(FrameData, ssboInfo), sizeof(VkDescriptorBufferInfo) }
};

VkDescriptorUpdateTemplateCreateInfo templateCI{};
templateCI.sType                      = VK_STRUCTURE_TYPE_DESCRIPTOR_UPDATE_TEMPLATE_CREATE_INFO;
templateCI.descriptorSetLayout        = setLayout;
templateCI.pipelineBindPoint          = VK_PIPELINE_BIND_POINT_GRAPHICS;
templateCI.pipelineLayout             = pipelineLayout;
templateCI.set                        = 0;
templateCI.descriptorUpdateEntryCount = 2;
templateCI.pDescriptorUpdateEntries   = entries;

VkDescriptorUpdateTemplate updateTemplate;
vkCreateDescriptorUpdateTemplate(device, &templateCI, nullptr, &updateTemplate);

// 프레임 갱신 시점
FrameData frameData{ uboBufferInfo, ssboBufferInfo };
vkUpdateDescriptorSetWithTemplate(device, descriptorSet, updateTemplate, &frameData);
```

---

## 11. 전형적 패턴

### 11.1. 글로벌 UBO (카메라/시간/옵션)

```c
struct GlobalUBO {
    mat4 view;
    mat4 proj;
    mat4 viewProj;
    vec4 cameraPos;
    float time;
    float deltaTime;
    uint32_t frameIdx;
    uint32_t flags;
};
// padding으로 16B 정렬 유지
constexpr size_t kAlignedSize = AlignUp(sizeof(GlobalUBO), 256);
VkBuffer globalUbo;
VkDeviceMemory globalUboMem;
// STAGING_BUFFER_BIT | UNIFORM_BUFFER_BIT usage
// HOST_VISIBLE | HOST_COHERENT 메모리 (매 프레임 map해서 갱신)

// descriptor set 갱신 (set 0 binding 0)
VkDescriptorBufferInfo info{ globalUbo, 0, kAlignedSize };
vkUpdateDescriptorSets(device, 1, &(VkWriteDescriptorSet){
    .sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET,
    .dstSet = frameSet, .dstBinding = 0, .dstArrayElement = 0,
    .descriptorCount = 1, .descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER,
    .pBufferInfo = &info,
}, 0, nullptr);
```

### 11.2. Per-Draw Dynamic UBO (머티리얼)

```c
// 큰 buffer에 256B 단위로 머티리얼 suballocate
VkBuffer materialPool;
// layout: UNIFORM_BUFFER_DYNAMIC
// range = 256 (alignment = sizeof(MaterialBlock), 둘이 같음)

// 매 draw
uint32_t dynOffset = drawIdx * 256;
vkCmdBindDescriptorSets(cmd, ..., 1, &set, 1, &dynOffset);
vkCmdDraw(...);
```

### 11.3. 큰 SSBO (particle / GI / voxel)

```c
VkBuffer ssbo;
VkDeviceMemory ssboMem;
// STORAGE_BUFFER_BIT usage, 큰 size
// DEVICE_LOCAL

// descriptor
VkDescriptorBufferInfo info{ ssbo, 0, VK_WHOLE_SIZE };
vkUpdateDescriptorSets(device, 1, &write, 0, nullptr);
```

### 11.4. Texel Buffer (HDR LUT)

```c
// VK_FORMAT_R16G16B16A16_SFLOAT LUT를 buffer로
VkBuffer lutBuf;  // STORAGE_TEXEL_BUFFER_BIT | TRANSFER_DST_BIT
// 1D float LUT 채우기 (스테이징에서 copy)

VkBufferView lutView;
vkCreateBufferView(device, &(VkBufferViewCreateInfo){
    .buffer = lutBuf,
    .format = VK_FORMAT_R16G16B16A16_SFLOAT,
    .range  = VK_WHOLE_SIZE,
}, nullptr, &lutView);

// 셰이더
layout(set = 0, binding = 5) uniform samplerBuffer hdrLut;  // sample
vec3 c = texelFetch(hdrLut, idx).rgb;
```

---

## 12. 자주 빠지는 주의사항

### 12.1. UBO/SSBO 일반

- [ ] `VkDescriptorBufferInfo::offset`이 alignment 한계(`minUniform/StorageBufferOffsetAlignment`)의 배수가 아님 → validation error.
- [ ] `range > max*Range` (UBO 보통 64KB, SSBO 더 큼 — 디바이스 조회 값) → VUID 위반.
- [ ] `buffer = VK_NULL_HANDLE`인데 `nullDescriptor` feature 비활성 (VUID-VkDescriptorBufferInfo-buffer-02998).
- [ ] `buffer = VK_NULL_HANDLE`인데 `offset != 0` 또는 `range != VK_WHOLE_SIZE` (VUID-buffer-02999).
- [ ] UBO를 read-only로 생성했는데 SSBO로 사용 (usage flag 불일치).
- [ ] buffer가 bound 안 됐거나 memory 미할당 상태에서 descriptor set update.

### 12.2. Dynamic Offset

- [ ] `vkCmdBindDescriptorSets`의 `dynamicOffsetCount` ≠ set 안의 dynamic descriptor 총 개수.
- [ ] dynamic offset이 alignment 배수가 아님.
- [ ] UBO와 SSBO dynamic offset을 **같은 배열**에 넣을 때 **순서** 틀림. set의 binding 순서대로 넣어야 함.
- [ ] 실제 오프셋은 `VkDescriptorBufferInfo::offset`(base) + `pDynamicOffsets[i]`이며, 유효 오프셋 + `range` ≤ 버퍼 크기(VUID-…-pDescriptorSets-01979).
- [ ] `range = VK_WHOLE_SIZE`면 동적 오프셋은 반드시 0이어야 한다(VUID-…-06715).

### 12.3. Texel Buffer

- [ ] `VkBufferView`의 format이 `VK_FORMAT_FEATURE_*_TEXEL_BUFFER_BIT` 미지원.
- [ ] `VkBuffer`의 usage에 `*_TEXEL_BUFFER_BIT` 누락.
- [ ] Storage texel atomic을 fragment shader에서 사용하는데 `fragmentStoresAndAtomics` 비활성.

### 12.4. SSBO 권한

- [ ] SSBO atomic 사용 시 디바이스가 `shaderBufferFloat32AtomicAdd` 같은 feature 미지원.
- [ ] SSBO size가 32비트 인덱싱 한계 초과(보통 2GB) + `shader64BitIndexing` 비활성.

### 12.5. Inline Uniform Block

- [ ] `descriptorCount`로 **descriptor 개수**가 아니라 **바이트 크기**를 줘야 함.
- [ ] `VkWriteDescriptorSetInlineUniformBlock`이 pNext에 없음.

### 12.6. 일반 / 실전

- [ ] Pool size 부족 → `VK_ERROR_OUT_OF_POOL_MEMORY`.
- [ ] `vkFreeDescriptorSets` 매 draw 호출 → 비효율. **set은 재사용**.
- [ ] `vkUpdateDescriptorSets` + `vkCmdBindDescriptorSets` 순서 혼동. set update는 **bind 전에** 끝나야 함.

---

## 13. `VK_EXT_descriptor_buffer` — 풀 없는 디스크립터 버퍼

디스크립터 풀 객체를 배제하고 일반 `VkBuffer`에 디스크립터 바이너리 데이터를 직접 기록하는 Vulkan 1.3+ 확장 기능이다.

- **장점**: 풀 단편화 제거, GPU 기반 디스크립터 생성 가능, 초고속 바인딩.
- **동작**: 물리 디바이스에서 디스크립터 크기(`uniformBufferDescriptorSize` 등)를 조회한 뒤, `VK_BUFFER_USAGE_RESOURCE_DESCRIPTOR_BUFFER_BIT_EXT` 버퍼를 생성하여 디스크립터를 순차적으로 기록한다. 바인딩 시 `vkCmdBindDescriptorBuffersEXT`와 `vkCmdSetDescriptorBufferOffsetsEXT`를 사용한다.

---

## 14. 빠른 참조 요약

| 디스크립터 종류 | 권장 사용 케이스 | 정렬 기준 | 크기 제한 (디바이스 조회 값) |
|----------------|----------------|-----------|----------|
| `UNIFORM_BUFFER` | 카메라 행렬, 씬 전역 설정, 조명 계수 | `minUniformBufferOffsetAlignment` (보통 256 B) | `maxUniformBufferRange` (보통 64 KB) |
| `UNIFORM_BUFFER_DYNAMIC` | 오브젝트별 머티리얼, 트랜스폼 테이블 | 위와 동일 | 위와 동일 |
| `STORAGE_BUFFER` | 스킨드 애니메이션 본 행렬, 파티클 데이터 | `minStorageBufferOffsetAlignment` (보통 256 B) | `maxStorageBufferRange` (보통 1 GB 이상) |
| `STORAGE_BUFFER_DYNAMIC` | 드로우별 가변 길이 인덱스/정점 버퍼 | 위와 동일 | 위와 동일 |
| `STORAGE_TEXEL_BUFFER` | HDR 룩업 테이블, 정형화된 물리 캐시 | 텍셀 블록 크기 | `maxTexelBufferElements` |
| `INLINE_UNIFORM_BLOCK` | 여러 드로우에 재사용되는 소량(수 KB) 상수 | 자체 정렬 | `maxInlineUniformBlockSize` (보통 4 KB) |
