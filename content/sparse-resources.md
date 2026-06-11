---
title: Sparse Resources
slug: sparse-resources
---

## 소개

**Sparse Resources**는 물리 메모리보다 큰 리소스를 다룰 수 있게 해주는 메커니즘이다. 디스크의 sparse file처럼, **일부 페이지만 메모리에 매핑**하고 나머지는 backing storage(디바이스 메모리)에 남겨둘 수 있다.

### 왜 필요한가

전통적 Vulkan 흐름은 **리소스 전체가 한 번에 fully resident**해야 한다. 다음 상황에서 문제:

| 상황 | 문제 |
|------|------|
| **16K × 16K 텍스처** (1GB+) | VRAM에 다 못 올림. 페이지 매핑 필수 |
| **스트리밍 메쉬** (대용량 SSBO) | 처음엔 일부만 resident, 디스크/시스템 메모리에서 채우기 |
| **타일 기반 deferred 셰이딩** | 화면에 보이는 타일만 resident, 나머지는 unmapped |
| **Virtual Texturing (Mega Texture)** | 디스크에 수 GB 텍스처, 보이는 부분만 VRAM에 |
| **타일 기반 GPU의 lazy allocation** | TBDR 디바이스에서 tile memory를 demand-allocated |

**Sparse의 핵심 아이디어:**

```
[기존]  VkImage (16 GB)  →  vkAllocateMemory (16 GB)  →  vkBindImageMemory
        ⚠ 메모리 16 GB 없으면 실패

[Sparse] VkImage (16 GB)  →  vkGetImageSparseMemoryRequirements  →  block 단위로 sparse bind
        VkDeviceMemory (1 GB, 필요에 따라 여러 개)  →  vkQueueBindSparse
        💡 unmapped 페이지는 셰이더가 안 읽게 디자인 → 사용 OK
```

장점:

- **메모리 한계 극복**: VRAM이 모자라도 **필요한 부분만** 차례로 올리며 작업
- **스트리밍**: 디스크/시스템 메모리 → VRAM으로 페이지 단위 로딩
- **유휴 페이지 절약**: 보이지 않는 mip이나 카메라 밖 타일은 매핑 안 함
- **메모리 풀링**: aliasing으로 여러 리소스가 같은 메모리 블록을 시간차 공유

대신 **복잡성 비용**이 따른다:

- 셰이더가 unmapped 영역을 읽지 않도록 **별도 가드** 필요
- `vkQueueBindSparse` + `VK_QUEUE_SPARSE_BINDING_BIT` 큐 관리
- 페이지 단위 동기화, lifetime, aliasing 규칙 모두 직접 다룸

> **용어 정리**
> - **Sparse Binding**: 리소스 전체를 한꺼번에 바인딩하지 않고, **page/block 단위**로 바인딩하는 능력.
> - **Sparse Residency**: 일부 페이지만 resident하고, 나머지는 **unmapped**. shader가 unmapped 페이지를 안 쓰게 디자인하면 사용 가능.
> - **Sparse Aliasing**: 여러 리소스가 같은 메모리 블록을 **시간차**로 공유.
> - **Block (Page)**: sparse의 최소 단위. 64KB(보통, buffer), 또는 format-specific(보통 64K texel, image).
> - **Mip-tail**: 큰 mip과 그 아래의 모든 작은 mip 묶음. opaque 메모리 영역. 한 번에 바인딩.
> - **vkQueueBindSparse**: sparse 바인딩을 큐에 제출하는 별도 명령. graphics/compute와 다른 큐.

이 문서는 **생성 → 요구사항 → 바인딩 → 큐 제출 → unmapped 가드** 흐름을 다룬다.

---

---

## 1. 큰 그림 — sparse vs 일반

```cmdstack
[일반]
VkBuffer/Image
  → vkBind*Memory(device, ...)  // 한 번에 fully bind
  → vkQueueSubmit(gfx/comp)

[Sparse]
VkBuffer/Image (flags: SPARSE_BINDING_BIT, ...)
  → vkGetBufferMemoryRequirements → alignment = sparse block size
  → (필요시) vkGetImageSparseMemoryRequirements → mip-tail 정보
  → vkQueueBindSparse(queue, ...,
        bufferBinds:   [...]  // page-by-page 바인딩
        imageOpaqueBinds:[...]  // mip-tail opaque 바인딩
        imageBinds:     [...]  // 일반 mip/page 바인딩
        signalSemaphores:[...])  // 완료 신호
  → 그래픽/컴퓨트 큐가 sparse 큐의 시그널을 waitSemaphore로 받음
```

**핵심 차이:**

| | 일반 | Sparse |
|---|------|--------|
| 바인딩 호출 | `vkBind*Memory` (한 번) | `vkQueueBindSparse` (큐 제출, 여러 번) |
| 바인딩 단위 | 전체 리소스 | block / page / mip-tail |
| 메모리 residency | 항상 fully resident | 부분 resident 가능 |
| 큐 종류 | graphics / compute / transfer | **VK_QUEUE_SPARSE_BINDING_BIT** 큐 |
| 동기화 | 자동 (필요 시 fence/semaphore) | 명시적 wait/signal semaphore |

---

---

## 2. 생성 — sparse 플래그

### 2.1. `VkBufferCreateInfo` (sparse)

```c
VkBufferCreateInfo bci{};
bci.size  = 16 * 1024 * 1024;  // 16 MB 가상 크기
bci.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT
          | VK_BUFFER_USAGE_TRANSFER_DST_BIT;  // backing memory 채우기용
bci.flags = VK_BUFFER_CREATE_SPARSE_BINDING_BIT
         | VK_BUFFER_CREATE_SPARSE_RESIDENCY_BIT   // 부분 resident
         | VK_BUFFER_CREATE_SPARSE_ALIASED_BIT;   // 별칭 가능 (선택)
```

| 플래그 | 의미 | 필요 feature |
|--------|------|--------------|
| `SPARSE_BINDING_BIT` | sparse 바인딩 사용 | `sparseBinding` |
| `SPARSE_RESIDENCY_BIT` | 부분 resident 가능 | `sparseResidencyBuffer` |
| `SPARSE_ALIASED_BIT` | 다른 리소스와 메모리 별칭 | (위 둘에 포함) |

> **스펙 원문 (NOTE)** "Specifying `VK_BUFFER_CREATE_SPARSE_RESIDENCY_BIT` requires specifying `VK_BUFFER_CREATE_SPARSE_BINDING_BIT`, as well."
>> RESIDENCY/BINDING 둘 다 켜져야 residency 의미가 있음.

> **스펙 원문 (VUID-VkBufferCreateInfo-None-01888)** "If any of the bits `VK_BUFFER_CREATE_SPARSE_BINDING_BIT`, `VK_BUFFER_CREATE_SPARSE_RESIDENCY_BIT`, or `VK_BUFFER_CREATE_SPARSE_ALIASED_BIT` are set, `VK_BUFFER_CREATE_PROTECTED_BIT` must not also be set."
>> sparse + protected 동시 불가.

> **스펙 원문 (VUID-VkBufferCreateInfo-pNext-01571)** If `VkDedicatedAllocationBufferCreateInfoNV::dedicatedAllocation` is `VK_TRUE`, then flags must not include any of the sparse bits.
>> dedicated allocation과 sparse 동시 불가 (NV).

### 2.2. `VkImageCreateInfo` (sparse)

```c
VkImageCreateInfo ici{};
ici.imageType     = VK_IMAGE_TYPE_2D;
ici.format        = VK_FORMAT_R8G8B8A8_UNORM;
ici.extent        = {16384, 16384, 1};  // GB 단위
ici.mipLevels     = 14;
ici.arrayLayers   = 1;
ici.samples       = VK_SAMPLE_COUNT_1_BIT;
ici.tiling        = VK_IMAGE_TILING_OPTIMAL;
ici.usage         = VK_IMAGE_USAGE_SAMPLED_BIT
                 | VK_IMAGE_USAGE_TRANSFER_DST_BIT;
ici.sharingMode   = VK_SHARING_MODE_EXCLUSIVE;
ici.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
ici.flags = VK_IMAGE_CREATE_SPARSE_BINDING_BIT
          | VK_IMAGE_CREATE_SPARSE_RESIDENCY_BIT  // 부분 resident
          | VK_IMAGE_CREATE_SPARSE_ALIASED_BIT;  // 메모리 별칭
```

> **스펙 원문** (image flags) `VK_IMAGE_CREATE_SPARSE_RESIDENCY_BIT`는 `VK_IMAGE_CREATE_SPARSE_BINDING_BIT`를 함의. residency는 `sparseResidency*` feature 필요.

**image sparse feature (다양):**

| Feature | 의미 |
|---------|------|
| `sparseBinding` | 기본 sparse 바인딩 |
| `sparseResidencyBuffer` | buffer residency |
| `sparseResidencyImage2D` | 2D image residency |
| `sparseResidencyImage3D` | 3D image residency |
| `sparseResidency2Samples` / `sparseResidency4Samples` / `sparseResidency8Samples` / `sparseResidency16Samples` | 멀티샘플 residency |
| `sparseResidencyAliased` | residency + aliasing 동시 |

모두 별도 feature. 사용하려는 image 파라미터(차원/샘플/residency/aliasing)에 맞는 feature를 활성화.

---

---

## 3. Sparse property 조회

### 3.1. 디바이스 sparse 속성

```c
VkPhysicalDeviceSparseProperties sp{};
vkGetPhysicalDeviceProperties(physDev, &props);
sp.residencyStandard2DBlockShape;     // 표준 2D block shape 지원
sp.residencyStandard2DMultisampleBlockShape;
sp.residencyStandard3DBlockShape;
sp.residencyAlignedMipSize;          // mip 크기 정렬
sp.residencyNonResidentStrict;        // unmapped → UB
sp.residencyStrict;                  // residency 엄격
```

`residencyNonResidentStrict == VK_TRUE`면 **unmapped 영역은 shader 접근 시 진짜 UB** (드라이버 가드 없음). `VK_FALSE`면 보통 0 또는 정의된 값으로 폴백.

### 3.2. Image sparse 요구사항

```c
uint32_t count;
vkGetImageSparseMemoryRequirements(device, image, &count, nullptr);
std::vector<VkSparseImageMemoryRequirements> reqs(count);
vkGetImageSparseMemoryRequirements(device, image, &count, reqs.data());

for (auto& r : reqs) {
    // r.formatProperties.aspectMask
    // r.formatProperties.imageGranularity (texel 블록 크기)
    // r.formatProperties.flags (SINGLE_MIPTAIL / ALIGNED_MIP_SIZE / NONSTANDARD_BLOCK_SIZE)
    // r.imageMipTailFirstLod
    // r.imageMipTailSize
    // r.imageMipTailOffset
    // r.imageMipTailStride
}
```

> **스펙 원문 (NOTE)** "If the image was not created with `VK_IMAGE_CREATE_SPARSE_RESIDENCY_BIT` then `pSparseMemoryRequirementCount` will be zero and `pSparseMemoryRequirements` will not be written to."
>> residency 안 켜면 sparse 요구사항 조회 자체가 안 됨.

### 3.3. `imageGranularity` — block size

`VkSparseImageFormatProperties::imageGranularity`는 **texel 단위 block 크기** (예: {64, 64, 1}). 메모리 바인딩의 단위. 한 block 안의 모든 texel은 같은 메모리 매핑을 공유.

---

---

## 4. `VkSparseMemoryBind` — 한 bind 단위

```c
typedef struct VkSparseMemoryBind {
    VkDeviceSize             resourceOffset;  // 리소스 안에서의 시작 (block-aligned)
    VkDeviceSize             size;            // 바인딩 크기 (> 0)
    VkDeviceMemory           memory;          // VK_NULL_HANDLE이면 unbind
    VkDeviceSize             memoryOffset;    // memory 안에서의 시작
    VkSparseMemoryBindFlags  flags;           // 0 또는 SPARSE_MEMORY_BIND_METADATA_BIT
} VkSparseMemoryBind;
```

> **스펙 원문 (VUID-VkSparseMemoryBind-resourceOffset-09491)** "If the resource being bound is a VkBuffer, `resourceOffset`, `memoryOffset` and `size` must be an integer multiple of the alignment of the `VkMemoryRequirements` structure returned from a call to `vkGetBufferMemoryRequirements` with the buffer resource."
>> **sparse block size = `vkGetBufferMemoryRequirements`의 `alignment` 값**. 모든 offset/size가 이 값의 배수.

> **스펙 원문 (VUID-VkSparseMemoryBind-resourceOffset-09492)** "If the resource being bound is a VkImage, `resourceOffset` and `memoryOffset` must be an integer multiple of the alignment of the `VkMemoryRequirements` structure returned from a call to `vkGetImageMemoryRequirements` with the image resource."
>> image도 같은 정렬 규칙.

> **스펙 원문 (VUID-VkSparseMemoryBind-memory-01097)** "If `memory` is not `VK_NULL_HANDLE`, `memory` must not have been created with a memory type that reports `VK_MEMORY_PROPERTY_LAZILY_ALLOCATED_BIT` bit set."
>> LAZILY_ALLOCATED 메모리는 sparse에 못 묶음. 그 메모리는 transient attachment 전용.

> **스펙 원문 (VUID-VkSparseMemoryBind-size-01098/01099/01100/01101/01102)** `size > 0`, `resourceOffset < resourceSize`, `resourceOffset + size <= resourceSize`, `memoryOffset < memorySize`, `size <= memorySize - memoryOffset`.

---

---

## 5. `VkSparseBufferMemoryBindInfo` — buffer sparse 바인딩

```c
typedef struct VkSparseBufferMemoryBindInfo {
    VkBuffer               buffer;          // SPARSE_BINDING_BIT로 생성된 buffer
    uint32_t               bindCount;
    const VkSparseMemoryBind*  pBinds;      // 위 VkSparseMemoryBind 배열
} VkSparseBufferMemoryBindInfo;
```

**예시: 64KB block 단위로 buffer suballocate**

```c
constexpr VkDeviceSize BLOCK = 64 * 1024;
VkBufferCreateInfo bci{};
bci.size  = 16 * 1024 * 1024;  // 16 MB
bci.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
bci.flags = VK_BUFFER_CREATE_SPARSE_BINDING_BIT
         | VK_BUFFER_CREATE_SPARSE_RESIDENCY_BIT;
VkBuffer sparseBuf;
vkCreateBuffer(device, &bci, nullptr, &sparseBuf);

VkMemoryRequirements memReq;
vkGetBufferMemoryRequirements(device, sparseBuf, &memReq);
assert(memReq.alignment == BLOCK);  // sparse block size

// 4개 page를 한 device memory에 묶음
VkDeviceMemory deviceMem;
vkAllocateMemory(device, &(VkMemoryAllocateInfo){
    .allocationSize  = 4 * BLOCK,
    .memoryTypeIndex = findMemoryType(memReq.memoryTypeBits, DEVICE_LOCAL),
}, nullptr, &deviceMem);

VkSparseMemoryBind binds[4] = {
    {0 * BLOCK, BLOCK, deviceMem, 0 * BLOCK, 0},  // page 0
    {1 * BLOCK, BLOCK, deviceMem, 1 * BLOCK, 0},  // page 1
    {2 * BLOCK, BLOCK, deviceMem, 2 * BLOCK, 0},  // page 2
    {3 * BLOCK, BLOCK, deviceMem, 3 * BLOCK, 0},  // page 3
};

VkSparseBufferMemoryBindInfo bufferBind{};
bufferBind.buffer    = sparseBuf;
bufferBind.bindCount  = 4;
bufferBind.pBinds     = binds;
```

> **스펙 원문** (스펙 36.7.5) "For all sparse resources the `VkMemoryRequirements::alignment` member specifies both the binding granularity in bytes and the required alignment of `VkDeviceMemory`."
>> `alignment`가 곧 sparse block size.

---

---

## 6. Image sparse 바인딩

### 6.1. `VkSparseImageOpaqueMemoryBindInfo` — mip-tail / metadata

```c
typedef struct VkSparseImageOpaqueMemoryBindInfo {
    VkImage                image;
    uint32_t                bindCount;
    const VkSparseMemoryBind* pBinds;
} VkSparseImageOpaqueMemoryBindInfo;
```

> **스펙 원문 (스펙 36.7.6 발췌)** "Binding the mip tail for any aspect must only be performed using `VkSparseImageOpaqueMemoryBindInfo`."
>> mip-tail은 **opaque bind**로만 묶음. 일반 image bind로는 안 됨.

> **스펙 원문** "If `formatProperties.flags` contains `VK_SPARSE_IMAGE_FORMAT_SINGLE_MIPTAIL_BIT`, then it can be bound with a single `VkSparseMemoryBind` structure, with `resourceOffset = imageMipTailOffset` and `size = imageMipTailSize`. If `formatProperties.flags` does not contain `VK_SPARSE_IMAGE_FORMAT_SINGLE_MIPTAIL_BIT` then the offset for the mip tail in each array layer is given as: `arrayMipTailOffset = imageMipTailOffset + arrayLayer * imageMipTailStride`; and the mip tail can be bound with `layerCount` `VkSparseMemoryBind` structures, each using `size = imageMipTailSize` and `resourceOffset = arrayMipTailOffset` as defined above."
>> `SINGLE_MIPTAIL_BIT`이 있으면 단일 bind로 모든 layer 처리. 없으면 layer마다 별도 bind + `imageMipTailStride`만큼 stride.

```c
VkSparseMemoryBind mipTailBind{};
mipTailBind.resourceOffset = req.imageMipTailOffset;
mipTailBind.size           = req.imageMipTailSize;
mipTailBind.memory         = mipTailMemory;
mipTailBind.memoryOffset   = 0;
// flags = 0 (color/depth mip-tail) 또는 SPARSE_MEMORY_BIND_METADATA_BIT (metadata)

VkSparseImageOpaqueMemoryBindInfo opaqueBind{};
opaqueBind.image     = sparseImage;
opaqueBind.bindCount = 1;
opaqueBind.pBinds    = &mipTailBind;
```

### 6.2. `VkSparseImageMemoryBindInfo` — 개별 mip / subresource

```c
typedef struct VkSparseImageMemoryBindInfo {
    VkImage                       image;
    uint32_t                       bindCount;
    const VkSparseImageMemoryBind* pBinds;
} VkSparseImageMemoryBindInfo;

typedef struct VkSparseImageMemoryBind {
    VkImageSubresource  subresource;        // mip + layer + aspect
    VkOffset3D          offset;             // texel (block-aligned)
    VkExtent3D          extent;             // texel (block-aligned)
    VkDeviceMemory      memory;
    VkDeviceSize        memoryOffset;
    VkSparseMemoryBindFlags  flags;         // 0 (METADATA는 opaque)
} VkSparseImageMemoryBind;
```

```c
// mip 0 layer 0의 (0,0)-(64,64) block 바인딩
VkSparseImageMemoryBind imageBind{};
imageBind.subresource  = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};  // mip 0, layer 0, 1 layer
imageBind.offset       = {0, 0, 0};
imageBind.extent       = {64, 64, 1};  // = imageGranularity
imageBind.memory       = tileMemory;
imageBind.memoryOffset = 0;

VkSparseImageMemoryBindInfo imageBindInfo{};
imageBindInfo.image     = sparseImage;
imageBindInfo.bindCount = 1;
imageBindInfo.pBinds    = &imageBind;
```

> **NOTE (스펙 발췌 36.4)** "Right-edges and bottom-edges of each level are allowed to have partially used sparse blocks. Any bound partially-used-sparse-blocks must still have their full sparse block size in bytes allocated in memory."
>> mip level이 block의 일부만 덮어도, **block 전체**만큼 메모리 할당해야 함.

### 6.3. Metadata 바인딩

이미지 metadata(`VK_IMAGE_ASPECT_METADATA_BIT`)는 별도 aspect로 바인딩. **반드시 `VK_SPARSE_MEMORY_BIND_METADATA_BIT` 플래그** 사용.

```c
VkSparseMemoryBind metadataBind{};
metadataBind.flags          = VK_SPARSE_MEMORY_BIND_METADATA_BIT;
metadataBind.resourceOffset = metadataImageMipTailOffset;  // metadata의 mip-tail
metadataBind.size           = metadataImageMipTailSize;
metadataBind.memory         = metadataMemory;
metadataBind.memoryOffset   = 0;
```

> **스펙 원문** "When binding memory explicitly for the `VK_IMAGE_ASPECT_METADATA_BIT` the application must use the `VK_SPARSE_MEMORY_BIND_METADATA_BIT` in the `VkSparseMemoryBind::flags` field when binding memory."
>> metadata는 일반 image bind가 아니라 **opaque bind + 메타데이터 플래그**.

---

---

## 7. `VkBindSparseInfo` + `vkQueueBindSparse` — 큐에 제출

```c
typedef struct VkBindSparseInfo {
    VkStructureType                             sType;
    const void*                                 pNext;
    uint32_t                                    waitSemaphoreCount;
    const VkSemaphore*                          pWaitSemaphores;
    uint32_t                                    bufferBindCount;
    const VkSparseBufferMemoryBindInfo*         pBufferBinds;
    uint32_t                                    imageOpaqueBindCount;
    const VkSparseImageOpaqueMemoryBindInfo*    pImageOpaqueBinds;
    uint32_t                                    imageBindCount;
    const VkSparseImageMemoryBindInfo*          pImageBinds;
    uint32_t                                    signalSemaphoreCount;
    const VkSemaphore*                          pSignalSemaphores;
} VkBindSparseInfo;

VkResult vkQueueBindSparse(
    VkQueue                   queue,             // VK_QUEUE_SPARSE_BINDING_BIT
    uint32_t                  bindInfoCount,
    const VkBindSparseInfo*   pBindInfo,
    VkFence                   fence);
```

### 7.1. 큐 요구사항

> **스펙 원문 (vkQueueBindSparse Command Properties)** "Supported Queue Types: `VK_QUEUE_SPARSE_BINDING_BIT`"
>> `vkQueueBindSparse`는 **반드시 sparse-capable 큐**에서만 호출. graphics/compute 큐에서 호출하면 에러.

디바이스 생성 시 `VK_QUEUE_SPARSE_BINDING_BIT`를 가진 큐 패밀리가 있는지 확인:

```c
VkQueueFamilyProperties props[...];
vkGetPhysicalDeviceQueueFamilyProperties(physDev, &count, props);
bool hasSparse = false;
for (auto& p : props) {
    if (p.queueFlags & VK_QUEUE_SPARSE_BINDING_BIT) { hasSparse = true; break; }
}
```

> **스펙 원문 (스펙 36.7.7 발췌)** "While some implementations may include `VK_QUEUE_SPARSE_BINDING_BIT` support in queue families that also include graphics and compute support, other implementations may only expose a `VK_QUEUE_SPARSE_BINDING_BIT`-only queue family. In either case, applications must use synchronization primitives to explicitly request any ordering dependencies between sparse memory binding operations and other graphics/compute/transfer operations, as sparse binding operations are not automatically ordered against command buffer execution, even within a single queue."
>> sparse binding은 **자동으로 ordering 안 됨**. 반드시 semaphore로 wait/signal.

### 7.2. Submit 패턴

```c
VkBindSparseInfo bindInfo{};
bindInfo.sType                 = VK_STRUCTURE_TYPE_BIND_SPARSE_INFO;
bindInfo.waitSemaphoreCount    = 1;
bindInfo.pWaitSemaphores       = &gfxFinishedSemaphore;  // gfx가 끝날 때까지 대기
bindInfo.bufferBindCount       = 1;
bindInfo.pBufferBinds          = &bufferBind;
bindInfo.imageOpaqueBindCount  = 1;
bindInfo.pImageOpaqueBinds     = &opaqueBind;
bindInfo.imageBindCount        = 0;
bindInfo.signalSemaphoreCount  = 1;
bindInfo.pSignalSemaphores     = &sparseDoneSemaphore;  // 바인딩 완료 후 시그널

vkQueueBindSparse(sparseQueue, 1, &bindInfo, VK_NULL_HANDLE);
```

> **스펙 원문 (스펙 15.2 발췌)** "The first synchronization scope of each semaphore signal operation defined by this structure includes all sparse binding operations defined by this structure. The second synchronization scope of each semaphore wait operation defined by this structure includes all sparse binding operations defined by this structure."
>> signal은 bind batch 완료 후, wait는 batch 시작 전. graphics/compute는 signal을 받아야 사용 가능.

### 7.3. Timeline semaphore + `vkQueueBindSparse` (1.3+)

```c
VkTimelineSemaphoreSubmitInfo timelineInfo{};
timelineInfo.sType                     = VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO;
timelineInfo.waitSemaphoreValueCount   = 1;
timelineInfo.pWaitSemaphoreValues      = &waitValue;      // bind 전까지 대기
timelineInfo.signalSemaphoreValueCount = 1;
timelineInfo.pSignalSemaphoreValues    = &signalValue;    // bind 완료 후 이 값으로 signal

VkBindSparseInfo bindInfo{};
bindInfo.sType                 = VK_STRUCTURE_TYPE_BIND_SPARSE_INFO;
bindInfo.pNext                 = &timelineInfo;  // ← timeline 정보 체이닝
bindInfo.waitSemaphoreCount    = 1;
bindInfo.pWaitSemaphores       = &timelineSemaphore;
bindInfo.signalSemaphoreCount  = 1;
bindInfo.pSignalSemaphores     = &timelineSemaphore;
bindInfo.bufferBindCount       = 1;
bindInfo.pBufferBinds          = &bufferBindInfo;

vkQueueBindSparse(sparseQueue, 1, &bindInfo, VK_NULL_HANDLE);
```

> **스펙 원문 (VUID-VkBindSparseInfo-pNext-03246/03247/03248)** Timeline semaphore 사용 시 `VkTimelineSemaphoreSubmitInfo` pNext 체이닝 필수. value count가 semaphore 수와 일치해야 함.

---

---

## 8. Unmapped 가드

**sparse image의 unmapped 영역은 shader가 접근하면 어떻게 되나?** 디바이스 한계에 따라 다름.

> **스펙 원문 (스펙 36.4.2, `residencyNonResidentStrict`)** If `residencyNonResidentStrict == VK_TRUE`, reads/writes to unmapped texels return **undefined** values (드라이버 가드 없음). 셰이더가 그 영역을 안 읽도록 디자인해야 함.
> If `VK_FALSE` (보통), 구현이 0 또는 정의된 값으로 폴백. 안전하지만 성능 손해 가능.

**실전 가드 패턴:**

| 패턴 | 용도 |
|------|------|
| Clip을 셰이더에서 | 클립맵·타일맵에서 unmapped 영역 = `discard` |
| Compute에서 영역 검사 | `isResident(uv)` 같은 함수가 false면 0/fallback 반환 |
| Mip 선택 | 큰 mip이 unmapped면 작은 mip으로 fallback |
| Page table | CPU가 추적. shader에 uniform으로 resident map 전달 |

> **NOTE (스펙 36.7.7 발췌)** "Implementations must provide a guarantee that simultaneously binding sparse blocks while another queue accesses those same sparse blocks via a sparse resource must not access memory owned by another process or otherwise corrupt the system."
>> 동시에 binding + 다른 큐 접근이 **system corruption은 일으키지 않음**. 다만 **읽기/쓰기 결과는 정의되지 않음** (race).

---

---

## 9. Aliasing

여러 리소스가 같은 메모리 블록을 **시간차**로 공유. **한 번에 하나만 resident**해야 함.

```c
// 리소스 A와 B가 같은 deviceMem[0..BLOCK-1]을 사용
// 1. A의 page 0을 mem[0]에 묶음 → A 사용 → 언바인딩
// 2. B의 page 0을 mem[0]에 묶음 → B 사용 → 언바인딩
```

> **스펙 원문 (스펙 36.6)** `VK_BUFFER_CREATE_SPARSE_ALIASED_BIT` 또는 `VK_IMAGE_CREATE_SPARSE_ALIASED_BIT` 필요. `sparseResidencyAliased` feature + 위 flag 동시 필요.

**주의:**

- 두 리소스의 **모두** `SPARSE_ALIASED_BIT`로 생성되어야 함
- 같은 메모리 블록이 두 곳에 동시에 묶이면 **둘 중 하나만 사용 가능**. 다른 쪽은 UB.
- lifetime 관리가 까다로움 → 보통 **queue family ownership** + **세마포어**로 보호

---

---

## 10. 전체 흐름 예시

```c
// 1) 큐 찾기
auto sparseFamily = findQueueFamily(VK_QUEUE_SPARSE_BINDING_BIT);
auto sparseQueue   = getQueue(sparseFamily, 0);

// 2) sparse buffer 생성
VkBuffer sparseBuf;
vkCreateBuffer(device, &(VkBufferCreateInfo){
    .size  = SIZE,
    .usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT,
    .flags = VK_BUFFER_CREATE_SPARSE_BINDING_BIT
           | VK_BUFFER_CREATE_SPARSE_RESIDENCY_BIT
           | VK_BUFFER_CREATE_SPARSE_ALIASED_BIT,
}, nullptr, &sparseBuf);

VkMemoryRequirements req;
vkGetBufferMemoryRequirements(device, sparseBuf, &req);
VkDeviceSize BLOCK = req.alignment;  // sparse block size

// 3) device memory (블록 묶음)
VkDeviceMemory mem;
vkAllocateMemory(device, &(VkMemoryAllocateInfo){
    .allocationSize  = NUM_PAGES * BLOCK,
    .memoryTypeIndex = findMemoryType(req.memoryTypeBits, DEVICE_LOCAL),
}, nullptr, &mem);

// 4) sparse bind batch
std::vector<VkSparseMemoryBind> binds;
for (uint32_t i = 0; i < NUM_PAGES; i++) {
    binds.push_back({i*BLOCK, BLOCK, mem, i*BLOCK, 0});
}
VkSparseBufferMemoryBindInfo bufBind{sparseBuf, (uint32_t)binds.size(), binds.data()};

VkBindSparseInfo info{};
info.sType                 = VK_STRUCTURE_TYPE_BIND_SPARSE_INFO;
info.bufferBindCount       = 1;
info.pBufferBinds          = &bufBind;
info.signalSemaphoreCount  = 1;
info.pSignalSemaphores     = &sparseDoneSemaphore;

vkQueueBindSparse(sparseQueue, 1, &info, VK_NULL_HANDLE);

// 5) graphics 큐에서 사용 (semaphore wait)
VkPipelineStageFlags stage = VK_PIPELINE_STAGE_VERTEX_SHADER_BIT;
VkSubmitInfo submit{};
submit.waitSemaphoreCount = 1;
submit.pWaitSemaphores    = &sparseDoneSemaphore;
submit.pWaitDstStageMask  = &stage;
submit.commandBufferCount = 1;
submit.pCommandBuffers    = &cmd;  // sparseBuf에 접근
vkQueueSubmit(gfxQueue, 1, &submit, fence);
```

---

---

## 11. Page streaming — 동적 bind/unbind

Mega texture 등에서 카메라 이동에 따라 페이지를 실시간으로 bind/unbind한다.

```c
// 해제 (unbind) — memory = VK_NULL_HANDLE
VkSparseMemoryBind unbind{};
unbind.resourceOffset = oldPageOffset;  // 해제할 페이지 시작
unbind.size           = BLOCK;
unbind.memory         = VK_NULL_HANDLE; // ← unbind
unbind.memoryOffset   = 0;

VkSparseBufferMemoryBindInfo unbindInfo{ sparseBuf, 1, &unbind };

// 새 바인딩
VkSparseMemoryBind bind{};
bind.resourceOffset = newPageOffset;
bind.size           = BLOCK;
bind.memory         = mem;  // 이미 allocate된 memory
bind.memoryOffset   = memSlot;

VkSparseBufferMemoryBindInfo bindInfo{ sparseBuf, 1, &bind };

// 하나의 batch에 해제 + 바인딩 동시 제출
VkBindSparseInfo info{};
info.sType                 = VK_STRUCTURE_TYPE_BIND_SPARSE_INFO;
info.bufferBindCount       = 2;
info.pBufferBinds          = (VkSparseBufferMemoryBindInfo[]){unbindInfo, bindInfo};
info.signalSemaphoreCount  = 1;
info.pSignalSemaphores     = &sparseDone;

vkQueueBindSparse(sparseQueue, 1, &info, VK_NULL_HANDLE);
```

> **주의**: 해제와 바인딩을 **같은 batch**에 넣으면 동기화 cost를 한 번으로 줄일 수 있다. 각각 다른 batch로 제출하면 불필요한 semaphore wait/signal 발생.

> **스펙 원문 (VUID-VkSparseMemoryBind-size-01098)** `size` must be greater than 0. unbind 시에도 size는 block alignment 배수.

---

---

## 12. 자주 빠지는 주의사항 모음

### 11.1. 생성

- [ ] `SPARSE_RESIDENCY_BIT`만 켜고 `SPARSE_BINDING_BIT` 안 켬 (자동 함의지만 명시 권장).
- [ ] `SPARSE_*_BIT` + `PROTECTED_BIT` 동시 (VUID-None-01888).
- [ ] `sparseBinding` feature 비활성 + SPARSE_BINDING_BIT (VUID-flags-...).
- [ ] `sparseResidencyBuffer` 비활성 + `VK_BUFFER_CREATE_SPARSE_RESIDENCY_BIT` (VUID-flags-01887).
- [ ] `sparseResidencyImage2D` 비활성 + `VK_IMAGE_CREATE_SPARSE_RESIDENCY_BIT` (VUID-flags-...).
- [ ] `sparseResidencyAliased` 비활성 + `VK_*_CREATE_SPARSE_ALIASED_BIT` (VUID-flags-...).
- [ ] `VkDedicatedAllocationBufferCreateInfoNV::dedicatedAllocation = VK_TRUE` + sparse flags (VUID-pNext-01571).

### 11.2. Property / 요구사항

- [ ] `residencyNonResidentStrict == VK_TRUE`인데 셰이더가 unmapped 영역 읽음 → UB.
- [ ] `vkGetImageSparseMemoryRequirements` 호출했지만 `SPARSE_RESIDENCY_BIT` 안 켜진 image → 결과 없음.
- [ ] `imageGranularity`를 무시하고 임의의 texel 범위로 image bind → 정렬 오류.

### 11.3. Bind

- [ ] `resourceOffset` 또는 `size`가 block alignment 배수가 아님 (VUID-resourceOffset-09491/09492).
- [ ] `resourceOffset + size > resourceSize` (VUID-size-01099/01100).
- [ ] `memory = LAZILY_ALLOCATED` 메모리 (VUID-memory-01097).
- [ ] `memoryOffset + size > memorySize` (VUID-memoryOffset-01101, size-01102).
- [ ] `memory != VK_NULL_HANDLE`인데 bind 영역이 memory requirements에 안 맞음 (VUID-memory-01096).
- [ ] `size == 0` (VUID-size-01098).
- [ ] mip-tail을 `VkSparseImageMemoryBindInfo`로 묶음 (opaque가 아님) → spec상 무효.
- [ ] metadata 바인딩 시 `VK_SPARSE_MEMORY_BIND_METADATA_BIT` 누락.
- [ ] `SINGLE_MIPTAIL_BIT` 없는 format인데 단일 bind로 모든 layer 처리 (layer별 stride 미적용).
- [ ] Partially used block도 block 전체 크기만큼 메모리 할당 안 함.

### 11.4. 큐 / 동기화

- [ ] graphics/compute 큐에서 `vkQueueBindSparse` 호출 → `VK_QUEUE_SPARSE_BINDING_BIT` 큐 필요.
- [ ] sparse binding과 graphics/compute 사이 명시적 동기화 누락. **자동 ordering 안 됨**.
- [ ] `signalSemaphores` 안 두고 `waitSemaphores`에 graphics 시그널만 둠 → graphics가 bind 완료 전에 sparseBuf 접근.
- [ ] `waitSemaphoreCount` ≠ `pWaitSemaphores` 길이 (VUID-...).
- [ ] Timeline semaphore 사용 시 `VkTimelineSemaphoreSubmitInfo` pNext 누락 (VUID-pNext-03246/03247/03248).

### 11.5. Aliasing

- [ ] 두 리소스가 `SPARSE_ALIASED_BIT` 둘 다 안 켜진 채 같은 메모리 공유 시도.
- [ ] 한 메모리 블록을 두 리소스에 **동시에** 묶음 → 둘 중 하나는 깨짐.
- [ ] `sparseResidencyAliased` feature 비활성.

### 11.6. Unmapped 가드

- [ ] `residencyNonResidentStrict = VK_TRUE`인데 셰이더가 unmapped 영역 접근 (가드 없음).
- [ ] Mip 선택 알고리즘이 unmapped mip을 무시하지 않음.
- [ ] Unmapped 영역을 0으로 폴백하는 셰이더가 `residencyNonResidentStrict = VK_TRUE` 환경에서 잘못된 데이터를 받음.

---

---

## 13. 빠른 참조

| 의도 | 권장 |
|------|------|
| GB 단위 가상 텍스처 (Mega Texture) | Image sparse + `SINGLE_MIPTAIL_BIT` |
| 큰 streamed mesh/SSBO | Buffer sparse + residency |
| 메모리 풀이 부족할 때 동적 매핑 | Sparse + aliasing |
| 디스크 기반 virtual texturing | Sparse + page table + 셰이더 fallback |
| 작은 mip이 resident | Mip-tail opaque bind |
| 큰 mip이 resident | Image bind per mip/region |

| 한계 | 의미 |
|------|------|
| `minUniformBufferOffsetAlignment`과 다름 | sparse block size = `VkMemoryRequirements::alignment` |
| `sparseBinding` | sparse 바인딩 기본 |
| `sparseResidencyBuffer` | buffer residency |
| `sparseResidencyImage2D/3D/Samples` | image residency |
| `sparseResidencyAliased` | aliasing 동시 |
| `residencyNonResidentStrict` | unmapped = UB (드라이버 가드 없음) |
