---
title: Uniform & Storage Buffer
slug: uniform-and-storage-buffers
---

## 소개

**Uniform Buffer (UBO)**와 **Storage Buffer (SSBO)**는 가장 흔한 디스크립터 두 종류다. 둘 다 `VkBuffer`를 셰이더에 노출하지만, **읽기만** vs **읽기+쓰기+atomic**이라는 차이가 있고 정렬·동적 오프셋·range 같은 별도 규칙이 있다.

> **용어 정리**
> - **UBO (Uniform Buffer)**: 셰이더에서 `read-only`. 작은 상수(카메라 행렬, 라이팅 파라미터)용.
> - **SSBO (Storage Buffer)**: 셰이더에서 `read/write/atomic`. 큰 가변 데이터(SSBO 인덱싱, particle state)용.
> - **Dynamic Offset**: `vkCmdBindDescriptorSets` 호출 시점에 추가하는 바이트 오프셋. 같은 디스크립터 셋의 다른 region을 빠르게 가리킴.
> - **Range**: `VkDescriptorBufferInfo::range`. `VK_WHOLE_SIZE` 가능. 단, UBO/SSBO의 max range 이내.
> - **Texel Buffer**: UBO/SSBO와 별도로, **포맷 변환된 픽셀**을 buffer로 노출. `VkBufferView` 필요.

이 문서는 **buffer 생성 → 디스크립터 업데이트 → 셰이더 사용 → 동적 오프셋** 흐름과 주의사항을 다룬다.

---

## 1. 큰 그림

```flowchart
flowchart TD
  A["VkBuffer + VkDeviceMemory (이미 생성됨, memory 문서 참고)"]
  B["VkDescriptorSetLayoutBinding:"]
  C["binding = 0"]
  D["descriptorType = UNIFORM_BUFFER | STORAGE_BUFFER | *_DYNAMIC | *_TEXEL_BUFFER | INLINE_UNIFORM_BLOCK"]
  E["descriptorCount = N"]
  F["stageFlags = VS | FS | CS | ..."]
  G["VkDescriptorPool (해당 타입 슬롯 N개)"]
  H(["vkAllocateDescriptorSets"])
  I["VkDescriptorBufferInfo { buffer, offset, range }"]
  J(["vkUpdateDescriptorSets — 또는 VkCopyDescriptorSets, update template"])
  K(["vkCmdBindDescriptorSets (..., dynamicOffsetCount, pDynamicOffsets)"])
  L["셰이더: layout(set, binding) uniform UBO { ... } | buffer SSBO { ... }"]
  A --> B --> C --> D --> E --> F --> G --> H --> I --> J --> K --> L
```

**핵심 포인트:**

- `buffer` 자체는 일반 `VkBuffer`. descriptor type이 셰이더 인터페이스를 결정.
- **정렬**과 **range**는 descriptor type과 디바이스 한계에 따라 다름.
- `INLINE_UNIFORM_BLOCK`은 별도 흐름 (`pBufferInfo` 안 쓰고 `VkWriteDescriptorSetInlineUniformBlock` pNext 사용).

---

## 2. 4종 + 2종 buffer descriptor

| descriptorType | buffer 필요? | 사용 권한 | 비고 |
|----------------|---------------|-----------|------|
| `UNIFORM_BUFFER` | 예 (UBO usage) | read | 가장 일반적 |
| `UNIFORM_BUFFER_DYNAMIC` | 예 | read | bind 시 dynamic offset 추가 |
| `STORAGE_BUFFER` | 예 (SSBO usage) | read/write/atomic | 가장 강력 |
| `STORAGE_BUFFER_DYNAMIC` | 예 | read/write/atomic | + dynamic offset |
| `UNIFORM_TEXEL_BUFFER` | 예 + **`VkBufferView`** | read | format 변환된 픽셀 |
| `STORAGE_TEXEL_BUFFER` | 예 + **`VkBufferView`** | read/write/atomic | format 변환된 픽셀 |

> **스펙 원문 (스펙 15.1.6)** "Storage texel buffer ... image load, store, and atomic operations can be performed on. ... Stores ... are supported in task, mesh and compute shaders ... Atomic operations ... When the `fragmentStoresAndAtomics` feature is enabled, stores and atomic operations are also supported in fragment shaders."
>> SSBO atomic은 보통 compute/mesh에서, fragment는 별도 feature 필요.

> **스펙 원문 (스펙 15.1.8)** "A uniform buffer ... is a descriptor type associated with a buffer resource directly, described in a shader as a structure ... load operations can be performed on."
>> UBO는 **읽기 전용**. 쓰면 UB 또는 다른 디스크립터.

> **스펙 원문 (스펙 15.1.7)** "A storage buffer ... is a descriptor type associated with a buffer resource directly, described in a shader as a structure ... load, store, and atomic operations can be performed on."
>> SSBO는 셰이더에서 완전 read/write.

---

## 3. `VkDescriptorBufferInfo` — 디스크립터 업데이트 입력

```c
typedef struct VkDescriptorBufferInfo {
    VkBuffer     buffer;
    VkDeviceSize offset;
    VkDeviceSize range;
} VkDescriptorBufferInfo;
```

| 필드 | 의미 |
|------|------|
| `buffer` | 대상 `VkBuffer`. `nullDescriptor` feature가 켜져 있으면 `VK_NULL_HANDLE` 가능. |
| `offset` | buffer 시작에서 몇 바이트. **alignment 한계의 배수**여야 함 (UBO/SSBO/dynamic 별도). |
| `range` | 노출할 바이트 수. `VK_WHOLE_SIZE` 가능. `descriptorType`의 `max*Range` 이내. |

> **스펙 원문 (VUID-VkDescriptorBufferInfo-offset-00340)** `offset` must be less than the size of buffer.
> **(VUID-VkDescriptorBufferInfo-range-00341)** If `range` is not equal to `VK_WHOLE_SIZE`, `range` must be greater than 0.
> **(VUID-VkDescriptorBufferInfo-range-00342)** If `range` is not equal to `VK_WHOLE_SIZE`, `range` must be less than or equal to the size of buffer minus `offset`.
> **(VUID-VkDescriptorBufferInfo-buffer-02999)** If `buffer` is `VK_NULL_HANDLE`, `offset` must be zero and `range` must be `VK_WHOLE_SIZE`.
>> `VK_NULL_HANDLE`은 `nullDescriptor` feature가 켜져 있을 때만. 켜져 있으면 `offset=0` + `range=VK_WHOLE_SIZE` 강제.

### 3.1. UBO / SSBO의 offset 정렬

| 디바이스 한계 | 일반 값 | 의미 |
|---------------|---------|------|
| `minUniformBufferOffsetAlignment` | **256** B | UBO의 `descriptorBufferInfo::offset`이 이 값의 배수 |
| `minStorageBufferOffsetAlignment` | **256** B | SSBO도 마찬가지 |
| `minTexelBufferOffsetAlignment` | 보통 16/32 B | texel buffer view의 `offset`이 (포맷의) texel block size 배수 |

> **실전 팁** UBO를 per-draw 데이터 풀처럼 **하나의 큰 buffer에 suballocate**하는 경우, `minUniformBufferOffsetAlignment` (= 256B) 단위로 정렬하지 않으면 `VUID-VkDescriptorBufferInfo-offset-...`류 validation 에러. 같은 buffer 안에서 stride를 256의 배수로 잡으면 안전.

### 3.2. UBO / SSBO의 range 한계

| 한계 | 일반 값 |
|------|---------|
| `maxUniformBufferRange` | 64 KB (보통) |
| `maxStorageBufferRange` | 1 GB ~ 2^32 - 1 |
| `maxTexelBufferElements` | 64K ~ 1G texels |

> **스펙 원문 (VUID-VkWriteDescriptorSet-...range...08763/08764)** If `descriptorType` is `STORAGE_BUFFER[_DYNAMIC]`, and the `shader64BitIndexing` feature is not enabled, the range must be less than or equal to `VkPhysicalDeviceLimits::maxStorageBufferRange`.
>> SSBO range가 한계 초과 시 32비트 인덱싱이 부족하다는 신호. `shader64BitIndexing` 켜면 한계 해제.

> **NOTE (스펙 발췌)** "When setting range to `VK_WHOLE_SIZE`, the effective range must not be larger than the maximum range for the descriptor type (`maxUniformBufferRange` or `maxStorageBufferRange`). This means that `VK_WHOLE_SIZE` is not typically useful in the common case where uniform buffer descriptors are suballocated from a buffer that is much larger than `maxUniformBufferRange`."
>> UBO suballocation 패턴에서는 `VK_WHOLE_SIZE`가 사실상 쓸모 없음. 명시적으로 작은 range를 줘야 함.

---

## 4. `vkUpdateDescriptorSets`로 descriptor 채우기

```c
VkDescriptorBufferInfo uboInfo{};
uboInfo.buffer = uboBuffer;
uboInfo.offset = 0;
uboInfo.range  = sizeof(GlobalUBO);

VkWriteDescriptorSet write{};
write.sType           = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
write.dstSet          = descriptorSet;
write.dstBinding      = 0;
write.dstArrayElement = 0;
write.descriptorCount = 1;
write.descriptorType  = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
write.pBufferInfo     = &uboInfo;

vkUpdateDescriptorSets(device, 1, &write, 0, nullptr);
```

> **스펙 원문 (스펙 15.2)** "For `VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER`, `VK_DESCRIPTOR_TYPE_STORAGE_BUFFER`, `VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC`, or `VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC`, all members of each element of `VkWriteDescriptorSet::pBufferInfo` are accessed."
>> 4종 buffer descriptor는 모두 `pBufferInfo`의 모든 필드 사용.

---

## 5. Dynamic UBO / SSBO Offset

`UNIFORM_BUFFER_DYNAMIC` / `STORAGE_BUFFER_DYNAMIC`은 **셰이더에 노출되는 region의 base offset**이 `vkUpdateDescriptorSets` 시점이 아닌 **`vkCmdBindDescriptorSets` 호출 시점**에 결정. CPU 측에서 매 draw/dispatch마다 다른 offset을 줄 수 있어 suballocation 패턴의 핵심.

```c
// Descriptor set: range는 고정 (alignment 단위)
VkDescriptorBufferInfo dynInfo{};
dynInfo.buffer = bigUBOPool;
dynInfo.offset = 0;
dynInfo.range  = 256;  // alignment와 같게

VkWriteDescriptorSet write{};
write.descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC;
write.pBufferInfo     = &dynInfo;
// ... dstSet, dstBinding, descriptorCount
vkUpdateDescriptorSets(device, 1, &write, 0, nullptr);

// 매 draw
for (uint32_t i = 0; i < numDraws; i++) {
    uint32_t offset = i * 256;  // alignment 배수
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS,
        pipelineLayout, 0, 1, &set, 1, &offset);
    vkCmdDraw(cmd, vc, 1, 0, 0);
}
```

> **스펙 원문 (스펙 15.1.9)** "A dynamic uniform buffer ... differs only in how the offset into the buffer is specified. The base offset calculated by the VkDescriptorBufferInfo when initially updating the descriptor set is added to a dynamic offset when binding the descriptor set."
>> `vkUpdateDescriptorSets`의 `offset`(= base) + `vkCmdBindDescriptorSets`의 dynamic offset = 실제 GPU가 보는 offset.

### 5.1. dynamic offset 제약

- **alignment**: dynamic offset은 **alignment의 배수**여야 함 (보통 256B)
- **개수**: `vkCmdBindDescriptorSets`의 `dynamicOffsetCount`는 set에 있는 **dynamic descriptor의 총 개수**와 일치해야 함 (descriptorCount 합)
- **합산**: set에 dynamic UBO 1개 + dynamic SSBO 1개 → `dynamicOffsetCount=2`, `pDynamicOffsets[0]=UBO offset`, `pDynamicOffsets[1]=SSBO offset`

> **실전 팁** `dynamicOffsetCount` 실수 매우 흔함. set 안의 dynamic descriptor 개수와 항상 일치하는지 assert/debug.

---

## 6. Texel Buffer (UNIFORM_TEXEL_BUFFER / STORAGE_TEXEL_BUFFER)

`VkBuffer`를 **포맷 변환된 픽셀 배열**로 노출. sampler로 픽셀을 샘플링하듯 buffer를 읽는다.

### 6.1. `VkBufferView` 생성

```c
VkBufferViewCreateInfo bvci{};
bvci.sType    = VK_STRUCTURE_TYPE_BUFFER_VIEW_CREATE_INFO;
bvci.buffer   = storageBuffer;  // VK_BUFFER_USAGE_*_TEXEL_BUFFER_BIT 필요
bvci.format   = VK_FORMAT_R32G32B32A32_SFLOAT;
bvci.offset   = 0;
bvci.range    = sizeof(MyStruct);  // VK_WHOLE_SIZE 가능

VkBufferView view;
vkCreateBufferView(device, &bvci, nullptr, &view);
```

> **스펙 원문 (VUID-VkBufferViewCreateInfo-buffer-00932)** `buffer` must have been created with at least one of `VK_BUFFER_USAGE_UNIFORM_TEXEL_BUFFER_BIT` or `VK_BUFFER_USAGE_STORAGE_TEXEL_BUFFER_BIT`.
>> texel buffer view는 texel usage 켜진 buffer에만.

> **스펙 원문 (VUID-VkBufferViewCreateInfo-format-08778/08779)** If the buffer view usage contains `VK_BUFFER_USAGE_UNIFORM_TEXEL_BUFFER_BIT`, then format features must contain `VK_FORMAT_FEATURE_UNIFORM_TEXEL_BUFFER_BIT`. Similarly for storage.
>> 포맷이 해당 usage를 지원해야 함. `vkGetPhysicalDeviceFormatProperties`로 사전 확인.

> **스펙 원문 (VUID-VkBufferViewCreateInfo-buffer-02750/02751)** For storage/uniform texel buffer view, `offset` must be a multiple of the effective alignment requirement of format for the descriptor type as defined by `minTexelBufferOffsetAlignment`.
>> format의 texel block size 배수여야 함.

### 6.2. 디스크립터로 사용

```c
VkWriteDescriptorSet write{};
write.descriptorType     = VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER;
write.pTexelBufferView   = &view;
// ... dstSet 등
vkUpdateDescriptorSets(device, 1, &write, 0, nullptr);
```

> **스펙 원문 (스펙 15.2)** "For `UNIFORM_TEXEL_BUFFER` or `STORAGE_TEXEL_BUFFER`, each element of `VkWriteDescriptorSet::pTexelBufferView` is accessed."
>> texel buffer는 `pTexelBufferView` 사용, `pBufferInfo` 아님.

### 6.3. 셰이더 측 (GLSL)

```glsl
// imageBuffer: 1D 형식화된 픽셀 배열
layout(set = 0, binding = 0) uniform imageBuffer myTexels;

vec4 c = imageLoad(myTexels, 0);  // 0번 texel 로드
imageStore(myTexels, 0, vec4(1,0,0,1));
```

---

## 7. Inline Uniform Block (INLINE_UNIFORM_BLOCK)

**Descriptor set의 backing storage에 직접 상수를 박는** 형태. 별도 buffer 없음. UBO와 같은 `layout(set, binding) uniform UBO`로 받지만 **메모리가 set 안에 있음**.

```c
VkWriteDescriptorSetInlineUniformBlock iub{};
iub.sType    = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET_INLINE_UNIFORM_BLOCK;
iub.dataSize = sizeof(MyInlineConstants);
iub.pData    = &constants;

VkWriteDescriptorSet write{};
write.descriptorType  = VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK;
write.dstBinding      = 2;
write.descriptorCount = sizeof(MyInlineConstants);  // 바이트 수!
write.pNext           = &iub;
vkUpdateDescriptorSets(device, 1, &write, 0, nullptr);
```

> **스펙 원문 (VUID 15.2)** "When updating descriptors with a descriptorType of `VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK`, none of the `pImageInfo`, `pBufferInfo`, or `pTexelBufferView` members are accessed, instead the source data of the descriptor update operation is taken from the `VkWriteDescriptorSetInlineUniformBlock` structure in the pNext chain of `VkWriteDescriptorSet`."
>> inline uniform은 `pBufferInfo` 등 안 쓰고 **pNext 구조체**에 데이터.

> **스펙 원문 (VUID-VkDescriptorSetLayoutBinding-...)** "In this case, `descriptorCount` specifies the upper bound on the byte size of the binding; thus it counts against the `maxInlineUniformBlockSize` and `maxInlineUniformTotalSize` limits instead."
>> `descriptorCount`가 보통은 descriptor 개수인데, inline uniform에서는 **바이트 크기**로 의미가 바뀜.

### 7.1. 한계

| 한계 | 의미 |
|------|------|
| `maxInlineUniformBlockSize` | 한 binding의 최대 바이트 (보통 4 KB) |
| `maxInlineUniformTotalSize` | 디바이스 전체 inline uniform 총합 (보통 64 KB) |
| `maxPerStageDescriptorInlineUniformBlocks` | 스테이지당 inline uniform binding 수 |

**push constant와의 비교:**

| | Push Constant | Inline Uniform Block |
|---|----|----|
| 메모리 위치 | GPU 내부 레지스터 | descriptor set storage |
| 최대 크기 | 128~256 B | 4 KB (per binding) |
| 갱신 명령 | `vkCmdPushConstants` | `vkUpdateDescriptorSets` |
| 디바이스 한계 | `maxPushConstantsSize` | `maxInlineUniformBlockSize` |
| 여러 draw 공유 | 명시적 재push | set 재바인딩 |

> **NOTE (스펙 15.1.11 발췌)** "Compared to push constants, they allow reusing the same set of constant data across multiple disjoint sets of drawing and dispatching commands."
>> inline uniform은 **여러 draw/dispatch 사이 공유 가능**한 작은 상수에 적합. push constant는 매번 갱신 필요.

---

## 8. Descriptor Pool — buffer 슬롯 만들기

```c
VkDescriptorPoolSize sizes[] = {
    { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER,           16 },
    { VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC,   8 },
    { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,           8 },
    { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC,   4 },
    { VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER,     4 },
    { VK_DESCRIPTOR_TYPE_INLINE_UNIFORM_BLOCK,     1024 },  // 바이트
};
VkDescriptorPoolCreateInfo poolCI{};
poolCI.sType         = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
poolCI.maxSets       = 32;
poolCI.poolSizeCount = std::size(sizes);
poolCI.pPoolSizes    = sizes;
vkCreateDescriptorPool(device, &poolCI, nullptr, &pool);
```

> **스펙 원문 (스펙 13.2.3)** descriptor type 별로 슬롯 개수 별도 카운트. 한 set이 UBO 1개 + SSBO 2개면 pool에 UBO 1, SSBO 2씩 소비.
>> pool 사이즈 부족하면 `vkAllocateDescriptorSets`가 `VK_ERROR_OUT_OF_POOL_MEMORY` 반환.

---

## 9. 전형적 패턴

### 9.1. 글로벌 UBO (카메라/시간/옵션)

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

### 9.2. Per-Draw Dynamic UBO (머티리얼)

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

### 9.3. 큰 SSBO (particle / GI / voxel)

```c
VkBuffer ssbo;
VkDeviceMemory ssboMem;
// STORAGE_BUFFER_BIT usage, 큰 size
// DEVICE_LOCAL

// descriptor
VkDescriptorBufferInfo info{ ssbo, 0, VK_WHOLE_SIZE };
vkUpdateDescriptorSets(device, 1, &write, 0, nullptr);
```

### 9.4. Texel buffer (HDR LUT)

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

## 10. 자주 빠지는 주의사항 모음

### 10.1. UBO/SSBO 일반

- [ ] `VkDescriptorBufferInfo::offset`이 alignment 한계(`minUniform/StorageBufferOffsetAlignment`)의 배수가 아님 → validation error.
- [ ] `range > max*Range` (UBO 64KB, SSBO 더 큼) → `VUID-VkWriteDescriptorSet-...range-...`.
- [ ] `buffer = VK_NULL_HANDLE`인데 `nullDescriptor` feature 비활성 (VUID-VkDescriptorBufferInfo-buffer-02998).
- [ ] `buffer = VK_NULL_HANDLE`인데 `offset != 0` 또는 `range != VK_WHOLE_SIZE` (VUID-buffer-02999).
- [ ] `range = VK_WHOLE_SIZE` + suballocate된 buffer → max range 초과 가능.
- [ ] UBO를 read-only로 생성했는데 SSBO로 사용 (usage flag 안 맞음).
- [ ] buffer가 bound 안 됐거나 memory 미할당 상태에서 descriptor set update.

### 10.2. Dynamic Offset

- [ ] `vkCmdBindDescriptorSets`의 `dynamicOffsetCount` ≠ set 안의 dynamic descriptor 총 개수.
- [ ] dynamic offset이 alignment 배수가 아님.
- [ ] UBO와 SSBO dynamic offset을 **같은 배열**에 넣을 때 **순서** 틀림. set의 binding 순서대로 넣어야 함.
- [ ] dynamic offset + base offset이 `buffer.size` 초과.

### 10.3. Texel Buffer

- [ ] `VkBufferView`의 format이 `VK_FORMAT_FEATURE_*_TEXEL_BUFFER_BIT` 미지원 (VUID-format-08778/08779).
- [ ] `VkBuffer`의 usage에 `*_TEXEL_BUFFER_BIT` 누락 (VUID-buffer-00932).
- [ ] `VkBufferView::offset`이 format의 texel block size 배수가 아님 (VUID-buffer-02750/02751).
- [ ] `pBufferInfo`로 texel buffer를 업데이트 (틀림 — `pTexelBufferView` 써야 함).
- [ ] Storage texel atomic을 fragment shader에서 사용하는데 `fragmentStoresAndAtomics` 비활성.

### 10.4. SSBO 권한

- [ ] SSBO atomic 사용 시 디바이스가 `shaderBufferFloat32AtomicAdd` 같은 feature 미지원.
- [ ] SSBO atomic인데 셰이더 멤버 타입이 SPIR-V atomic 가능 타입이 아님.
- [ ] SSBO size가 32비트 인덱싱 한계 초과 (보통 2GB) + `shader64BitIndexing` 비활성.
- [ ] UBO를 SSBO로 사용 (읽기만 되는 buffer를 load+store로 사용).

### 10.5. Inline Uniform Block

- [ ] `descriptorCount`로 **descriptor 개수**가 아니라 **바이트 크기**를 줘야 함.
- [ ] `VkWriteDescriptorSetInlineUniformBlock`이 pNext에 없음 (VUID-pNext-...).
- [ ] `descriptorCount * n`(n binding 개수) > `maxInlineUniformBlockSize` 또는 풀 합계 > `maxInlineUniformTotalSize`.
- [ ] `VkWriteDescriptorSet::pBufferInfo`도 같이 채움 — inline uniform은 무시되지만 일관성 차원에서 nullptr 권장.

### 10.6. 일반 / 실전

- [ ] Pool size 부족 → `VK_ERROR_OUT_OF_POOL_MEMORY` → `vkResetDescriptorPool` 안 함.
- [ ] `vkFreeDescriptorSets` 매 draw 호출 → 비효율. **set은 재사용**.
- [ ] `vkUpdateDescriptorSets` + `vkCmdBindDescriptorSets` 순서 헷갈. set update는 **bind 전에** 끝나야 함.
- [ ] 같은 buffer를 UBO + SSBO 두 descriptor로 동시에 노출 — 보통 무효는 아니지만 의도 불명.
- [ ] **descriptor type / buffer usage / shader 인터페이스** 셋이 안 맞음 (UBO인데 TRANSFER_DST만 켜진 buffer 등).

---

## 10. Descriptor Update Template (`VkDescriptorUpdateTemplate`, 1.2+)

`vkUpdateDescriptorSets`를 여러 번 호출하면 CPU 오버헤드가 크다. Template으로 **한 번의 호출에 모든 바인딩을 push**할 수 있다.

```c
// Template 정의: set layout의 바인딩과 매핑
VkDescriptorUpdateTemplateEntry entries[] = {
    { 0, 0, 1, VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER, offsetof(Data, ubo), sizeof(VkDescriptorBufferInfo) },
    { 1, 0, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, offsetof(Data, ssbo), sizeof(VkDescriptorBufferInfo) },
};

VkDescriptorUpdateTemplateCreateInfo templateCI{};
templateCI.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_UPDATE_TEMPLATE_CREATE_INFO;
templateCI.descriptorSetLayout = setLayout;
templateCI.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS; // 또는 없으면 0
templateCI.pipelineLayout = pipelineLayout;
templateCI.set = 0;
templateCI.descriptorUpdateEntryCount = 2;
templateCI.pDescriptorUpdateEntries = entries;

VkDescriptorUpdateTemplate updateTemplate;
vkCreateDescriptorUpdateTemplate(device, &templateCI, nullptr, &updateTemplate);

// 매 프레임
struct Data { VkDescriptorBufferInfo ubo; VkDescriptorBufferInfo ssbo; } data;
data.ubo  = { ubobuf, 0, sizeof(UBO) };
data.ssbo = { ssobuf, 0, VK_WHOLE_SIZE };
vkUpdateDescriptorSetWithTemplate(device, descriptorSet, updateTemplate, &data);
```

**장점**: `vkUpdateDescriptorSets`의 개별 호출을 하나의 `memcpy`-like call로 대체. 매 프레임 수천 개의 descriptor update에 특히 효과적.

---

## 11. `VK_EXT_descriptor_buffer` — Pool 없는 Descriptor (1.3+)

Descriptor pool을 없애고 **`VkBuffer`에 descriptor 데이터를 직접 기록**하는 확장. bindless / GPU-driven rendering에서 표준.

```c
// 1) Physical device properties
VkPhysicalDeviceDescriptorBufferPropertiesEXT props{};
props.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DESCRIPTOR_BUFFER_PROPERTIES_EXT;
vkGetPhysicalDeviceProperties2(physDev, &(VkPhysicalDeviceProperties2){
    .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2,
    .pNext = &props,
});
// props.uniformBufferDescriptorSize → UBO descriptor 1개당 byte stride

// 2) Descriptor buffer (GPU-visible)
VkBuffer descBuf;
vkCreateBuffer(device, &(VkBufferCreateInfo){
    .size  = maxDescriptors * props.uniformBufferDescriptorSize,
    .usage = VK_BUFFER_USAGE_RESOURCE_DESCRIPTOR_BUFFER_BIT_EXT
           | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
}, nullptr, &descBuf);

// 3) Set layout 호환 (DESCRIPTOR_BUFFER_BIT_EXT)
VkDescriptorSetLayoutCreateInfo layoutCI{};
layoutCI.flags = VK_DESCRIPTOR_SET_LAYOUT_CREATE_DESCRIPTOR_BUFFER_BIT_EXT;
// ... bindings ...

// 4) Set을 할당하지 않고 descriptor buffer + offset을 직접 bind
VkDescriptorBufferBindingInfoEXT bindInfo{};
bindInfo.sType  = VK_STRUCTURE_TYPE_DESCRIPTOR_BUFFER_BINDING_INFO_EXT;
bindInfo.address = getBufferDeviceAddress(descBuf) + setOffset;  // set 시작 주소
bindInfo.usage   = VK_BUFFER_USAGE_RESOURCE_DESCRIPTOR_BUFFER_BIT_EXT;

vkCmdBindDescriptorBuffersEXT(commandBuffer, 1, &bindInfo);

// 5) Set offset을 set number로 binding
uint32_t bufferOffset = setIdx * setSize;
vkCmdSetDescriptorBufferOffsetsEXT(commandBuffer,
    VK_PIPELINE_BIND_POINT_GRAPHICS, pipelineLayout,
    0, 1, &setIdx, &bufferOffset);
```

**핵심 차이**:

| | Descriptor Pool | Descriptor Buffer |
|---|---|---|
| 할당자 | `vkAllocateDescriptorSets` | `VkBuffer`에 직접 write |
| 동기화 | pool/set 단위 | buffer 배리어 (UBO/SSBO처럼) |
| 메모리 | 풀 전용 메모리 | device buffer |
| bind 명령 | `vkCmdBindDescriptorSets` | `vkCmdBindDescriptorBuffersEXT` + `vkCmdSetDescriptorBufferOffsetsEXT` |
| 조각화 | 발생 가능 | 없음 (buffer에 sequential write) |

> **주의**: descriptor buffer는 `VK_EXT_descriptor_buffer` feature + `VK_BUFFER_USAGE_RESOURCE_DESCRIPTOR_BUFFER_BIT_EXT` usage 필요. `extensions-foundation.md` 참고.

---

## 12. 빠른 참조 — 한 표로 보는 buffer descriptor

| descriptorType | buffer usage | pInfo 필드 | range 한계 | 정렬 | atomic | 셰이더 |
|----------------|--------------|------------|------------|------|--------|--------|
| `UNIFORM_BUFFER` | `UNIFORM_BUFFER_BIT` | `pBufferInfo` | `maxUniformBufferRange` (보통 64KB) | 256B | ❌ | `uniform UBO` |
| `UNIFORM_BUFFER_DYNAMIC` | `UNIFORM_BUFFER_BIT` | `pBufferInfo` | 동일 | 256B | ❌ | 동일 |
| `STORAGE_BUFFER` | `STORAGE_BUFFER_BIT` | `pBufferInfo` | `maxStorageBufferRange` (~1GB) | 256B | ✅ | `buffer SSBO` |
| `STORAGE_BUFFER_DYNAMIC` | `STORAGE_BUFFER_BIT` | `pBufferInfo` | 동일 | 256B | ✅ | 동일 |
| `UNIFORM_TEXEL_BUFFER` | `UNIFORM_TEXEL_BUFFER_BIT` | `pTexelBufferView` | `maxTexelBufferElements` (texel) | texel block size | ❌ | `samplerBuffer` / `imageBuffer` (read) |
| `STORAGE_TEXEL_BUFFER` | `STORAGE_TEXEL_BUFFER_BIT` | `pTexelBufferView` | 동일 | texel block size | ✅ | `imageBuffer` (read/write) |
| `INLINE_UNIFORM_BLOCK` | (없음) | `pNext` (VkWriteDescriptorSetInlineUniformBlock) | `maxInlineUniformBlockSize` (~4KB) | n/a | ❌ | `uniform UBO` |

| 의도 | 권장 |
|------|------|
| 카메라 행렬, 시간 | UBO (전역 set, 보통 갱신 적음) |
| 머티리얼, 인스턴스 데이터 | UBO_DYNAMIC (per-draw offset) |
| 가변 particle/voxel/GI 데이터 | SSBO |
| 인덱싱 큰 데이터 | SSBO + `shader64BitIndexing` |
| HDR LUT, BC 텍스처 압축 데이터 | STORAGE_TEXEL_BUFFER |
| 여러 draw 공유 작은 상수 | INLINE_UNIFORM_BLOCK |
| draw/dispatch마다 다른 작은 상수 | PUSH_CONSTANT |
