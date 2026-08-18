---
title: 버퍼 & 이미지
slug: buffers-and-images
---

## 소개

Vulkan의 모든 GPU 리소스는 결국 **버퍼(`VkBuffer`)** 또는 **이미지(`VkImage`)** 두 가지로 귀결된다. 정점·인덱스·유니폼·스토리지·인디렉트·유니폼 텍셀 등은 전부 버퍼로, 텍스처·렌더 타깃·디퍼스/스텐실·스왑체인 이미지는 전부 이미지로 만든다.

> **용어 정리**
> - **버퍼(Buffer)**: 선형(linear) 바이트 배열. 디스크립터로 바인딩하거나 `vkCmdCopy*`로 복사하는 식으로 사용.
> - **이미지(Image)**: 다차원 픽셀/텍셀 배열. 셰이더에서 샘플링/로드/스토어 하려면 반드시 `VkImageView`를 거쳐야 한다.
> - **서브리소스(Subresource)**: 이미지의 한 mip level × 한 array layer × 한 aspect(color/depth/stencil/plane). 한 이미지는 여러 서브리소스로 구성된다.
> - **레이아웃(Layout)**: 이미지가 현재 어떤 용도로 해석되는지를 나타내는 상태. 잘못된 레이아웃에서 사용하면 정의되지 않은 동작.

이 문서는 **생성 → 뷰 → 복사** 흐름과 자주 빠지는 주의사항을 정리한다. 메모리 타입 선택 / 정렬 / 캐시 정책 자체는 `메모리` 문서를 참고한다.

---

## 1. 큰 그림 — 리소스 생성과 사용 흐름

```flowchart
flowchart TD
  A["VkBuffer / VkImage — 핸들(리소스 자체, 메모리 미할당)"]
  B(["vkGetBufferMemoryRequirements / vkGetImageMemoryRequirements"])
  C(["VkDeviceMemory 할당 + vkBindBufferMemory / vkBindImageMemory"])
  D["(필요 시) VkImageView 생성"]
  E(["Descriptor Set 갱신 / vkCmdBind* / vkCmdCopy* / 렌더 패스 첨부"])
  F(["(필요 시) vkDestroyImageView → vkDestroyImage / vkDestroyBuffer → vkFreeMemory"])
  A --> B --> C --> D --> E --> F
```

**핵심 포인트:**

- 핸들(`VkBuffer`, `VkImage`)을 만든다고 메모리가 생기는 게 아니다. 반드시 메모리 요구사항을 조회 → 할당 → 바인드까지 해야 GPU가 접근할 수 있다.
- 이미지를 텍스처/첨부로 사용하려면 **거의 항상** `VkImageView`가 필요하다. 디스크립터에 raw `VkImage`를 직접 넣을 수 없다.
- **레이아웃**(Layout)은 이미지에만 존재한다. 버퍼에는 레이아웃 개념이 없다.

---

## 2. `VkBuffer` — 버퍼 생성

`vkCreateBuffer`로 만들고, `vkGetBufferMemoryRequirements`로 메모리 요구사항을 조회한 뒤, `vkBindBufferMemory`로 GPU 메모리에 바인딩한다.

```c
typedef struct VkBufferCreateInfo {
    VkStructureType        sType;
    const void*            pNext;
    VkBufferCreateFlags    flags;
    VkDeviceSize           size;                  // 0보다 커야 함 (VUID-size-00912)
    VkBufferUsageFlags     usage;                 // 0이면 안 됨 (VUID-None-09500)
    VkSharingMode          sharingMode;
    uint32_t               queueFamilyIndexCount;
    const uint32_t*        pQueueFamilyIndices;   // sharingMode=EXCLUSIVE면 무시
} VkBufferCreateInfo;
```

> **스펙 원문 (VUID-VkBufferCreateInfo-usage-...)** usage must be a valid combination of `VkBufferUsageFlagBits` values and must not be 0. `size` must be greater than 0.

### 2.1. `usage` 플래그 — 무엇에 쓸지에 따라 미리 선언

한 번 만들면 `usage`는 바꿀 수 없으므로, **해당 버퍼가 닿을 모든 경로**를 OR로 묶어 선언한다.

| 플래그 | 의미 / 대표 사용처 |
|--------|-------------------|
| `TRANSFER_SRC` | `vkCmdCopyBuffer`의 src, `vkCmdCopyBufferToImage`의 src 버퍼 |
| `TRANSFER_DST` | `vkCmdCopyBuffer`의 dst, `vkCmdCopyImageToBuffer`의 dst, `vkCmdFillBuffer` |
| `UNIFORM_TEXEL_BUFFER` | 텍셀 단위로 읽는 uniform buffer view |
| `STORAGE_TEXEL_BUFFER` | 텍셀 단위로 읽고/쓰는 storage buffer view |
| `UNIFORM_BUFFER` | UBO. `minUniformBufferOffsetAlignment` 정렬 |
| `STORAGE_BUFFER` | SSBO. `minStorageBufferOffsetAlignment` 정렬 |
| `INDEX_BUFFER` | `vkCmdBindIndexBuffer` |
| `VERTEX_BUFFER` | `vkCmdBindVertexBuffers` |
| `INDIRECT_BUFFER` | `vkCmdDrawIndirect` / `vkCmdDispatchIndirect` / 인디렉트 카운트 |
| `SHADER_DEVICE_ADDRESS` | 셰이더에서 `bufferDeviceAddress`로 읽기 (VK_KHR_buffer_device_address / 1.2+) |
| `CONDITIONAL_RENDERING_BIT_EXT` | 조건부 렌더링에서 조건 버퍼 |
| `TRANSFORM_FEEDBACK_BUFFER_BIT_EXT` / `ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_BIT_KHR` | TF / AS 빌드 입력 등 특수 용도 |

> **주의** `STORAGE_BUFFER`로 쓰면서 `SHADER_DEVICE_ADDRESS`도 같이 켜고, transfer로도 업로드한다면 → `STORAGE_BUFFER | SHADER_DEVICE_ADDRESS | TRANSFER_DST`처럼 OR로 합친다. 빠뜨리면 validation 레이어가 잡거나, GPU가 invalid 상태로 만든다.

### 2.2. `flags` — Sparse / Protected / 별칭

- `SPARSE_BINDING_BIT`, `SPARSE_RESIDENCY_BIT`, `SPARSE_ALIASED_BIT`: 스파스 리소스. 각 비트는 device feature 활성화가 선행 조건이고, residency를 켜면 binding도 자동 포함된다.
- `PROTECTED_BIT`: `protectedMemory` feature 필요. 보안 큐에서만 접근 가능. `vkMapMemory`로 CPU 접근 불가.
- `DEVICE_ADDRESS_CAPTURE_REPLAY_BIT`: `bufferDeviceAddressCaptureReplay` feature 필요. 캡처/리플레이용 고정 device address.

### 2.3. `sharingMode` — 큐 패밀리 공유

- `EXCLUSIVE`(기본값): 한 번에 한 큐 패밀리만 접근. 가장 빠르고 대부분의 경우 충분.
- `CONCURRENT`: 여러 큐 패밀리가 동시 접근. `queueFamilyIndexCount >= 2`이고 모든 원소가 **유일**해야 한다.

> **실전 팁** 단일 큐(예: 그래픽스 큐만 사용)면 항상 `EXCLUSIVE`로 두는 게 정석. `CONCURRENT`는 명시적 소유권 이전 배리어를 생략할 수 있다는 이점이 있으나, 드라이버가 내부적으로 추가 추적을 해야 해서 성능이 떨어질 수 있다.

### 2.4. 일반적인 버퍼 생성 코드

```c
VkBufferCreateInfo bufCI{};
bufCI.sType   = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
bufCI.size    = vertexDataSize;
bufCI.usage   = VK_BUFFER_USAGE_VERTEX_BUFFER_BIT
              | VK_BUFFER_USAGE_TRANSFER_DST_BIT;  // 스테이징에서 복사해 채움
bufCI.sharingMode = VK_SHARING_MODE_EXCLUSIVE;

VkBuffer vertexBuffer;
vkCreateBuffer(device, &bufCI, nullptr, &vertexBuffer);

VkMemoryRequirements memReqs;
vkGetBufferMemoryRequirements(device, vertexBuffer, &memReqs);

VkMemoryAllocateInfo allocInfo{};
allocInfo.sType           = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
allocInfo.allocationSize  = memReqs.size;
allocInfo.memoryTypeIndex = findMemoryType(memReqs.memoryTypeBits,
    VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);

VkDeviceMemory mem;
vkAllocateMemory(device, &allocInfo, nullptr, &mem);
vkBindBufferMemory(device, vertexBuffer, mem, 0);
```

---

## 3. `VkImage` — 이미지(텍스처) 생성

이미지는 다차원 텍셀 블록 배열이다. `vkCreateImage`로 만들고, `vkGetImageMemoryRequirements` → `vkBindImageMemory`로 GPU 메모리에 연결한다.

```c
typedef struct VkImageCreateInfo {
    VkStructureType          sType;
    const void*              pNext;
    VkImageCreateFlags       flags;
    VkImageType              imageType;       // 1D / 2D / 3D
    VkFormat                 format;          // VK_FORMAT_UNDEFINED 사용 시 pNext에 외부 포맷
    VkExtent3D               extent;          // width/height/depth 모두 > 0
    uint32_t                 mipLevels;       // > 0
    uint32_t                 arrayLayers;     // > 0
    VkSampleCountFlagBits    samples;         // 멀티샘플. color/depth 첨부 외엔 1_BIT
    VkImageTiling            tiling;          // OPTIMAL(권장) / LINEAR
    VkImageUsageFlags        usage;
    VkSharingMode            sharingMode;
    uint32_t                 queueFamilyIndexCount;
    const uint32_t*          pQueueFamilyIndices;
    VkImageLayout            initialLayout;   // UNDEFINED / PREINITIALIZED / ZERO_INITIALIZED_EXT
} VkImageCreateInfo;
```

> **스펙 원문 (VUID-VkImageCreateInfo-initialLayout-00993)** `initialLayout` must be `VK_IMAGE_LAYOUT_UNDEFINED` or `VK_IMAGE_LAYOUT_PREINITIALIZED` (또는 `VK_IMAGE_LAYOUT_ZERO_INITIALIZED_EXT`, `zeroInitializeDeviceMemory` feature 필요). 외부 메모리 핸들을 쓰는 경우 `UNDEFINED`로 제한된다(VUID-pNext-01443).

### 3.1. `imageType` — 차원

- `VK_IMAGE_TYPE_1D`: 1차원. `extent.height`, `extent.depth`는 1.
- `VK_IMAGE_TYPE_2D`: 텍스처·렌더 타깃의 기본.
- `VK_IMAGE_TYPE_3D`: 볼륨 텍스처. `arrayLayers`는 1, `flags`에 `CUBE_COMPATIBLE_BIT` 불가.

### 3.2. `format` — 픽셀 포맷

- 컬러/디퍼스/스텐실/멀티플랜(YCbCr)/압축(BC/ASTC/ETC) 등.
- 생성 전 `vkGetPhysicalDeviceFormatProperties`로 해당 포맷이 **format features**에서 요구하는 usage 비트를 지원하는지 확인한다.
- `VK_FORMAT_UNDEFINED`는 pNext의 `VkExternalFormatANDROID` 같은 외부 포맷 구조체와 함께만 쓸 수 있다(VUID-format-01975).

> **스펙 원문 (VUID-VkImageCreateInfo-format-...)** `_422`/`_420` suffix 포맷의 경우 `extent.width`가 2의 배수, `_420`는 `extent.height`도 2의 배수여야 한다. YCbCr 변환이 필요한 포맷은 `imageType=2D`, `mipLevels=1`, `arrayLayers=1`(ycbcrImageArrays 활성화 시 예외), `samples=1_BIT`이 강제된다.

### 3.3. `tiling` — 메모리 배치

- `OPTIMAL`: GPU가 내부적으로 재배치. 거의 모든 경우 이걸 쓰면 된다. CPU에서 직접 읽기 어렵다.
- `LINEAR`: 행 단위로 정렬. CPU 매핑/맵핑 기반 업로드에 유리. 단 **제약이 매우 강하다**: 2D, mipLevels=1, arrayLayers=1, samples=1, usage는 `TRANSFER_SRC/DST`만 허용(VUID-tiling-...).

> **스펙 원문** "Creation of images with tiling `VK_IMAGE_TILING_LINEAR` may not be supported unless other parameters meet all of the constraints..." → LINEAR 타일링은 일반 텍스처로 쓸 수 없고, 사실상 **CPU에서 채워서 GPU로 한 번만 복사**하는 임시 경로에만 사용.

### 3.4. `usage` — 이미지로 무엇을 할 것인가

| 플래그 | 의미 |
|--------|------|
| `TRANSFER_SRC` | `vkCmdCopyImage*` / `vkCmdBlitImage`의 src |
| `TRANSFER_DST` | 업로드·클리어 타깃 |
| `SAMPLED` | 셰이더에서 텍스처 샘플링 |
| `STORAGE` | 셰이더에서 이미지 load/store (읽기/쓰기) |
| `COLOR_ATTACHMENT` | 렌더 패스 / dynamic rendering의 컬러 첨부 |
| `DEPTH_STENCIL_ATTACHMENT` | 디퍼스·스텐실 첨부 |
| `INPUT_ATTACHMENT` | 서브패스 입력 (서브패스에서 픽셀로 읽기) |
| `TRANSIENT_ATTACHMENT` | `LAZILY_ALLOCATED` 메모리와 함께 쓰는 임시 첨부 |
| `SHADING_RATE_IMAGE_BIT_NV` / `FRAGMENT_SHADING_RATE_ATTACHMENT_BIT_KHR` | 셰이딩 레이트 특수 용도 |
| `HOST_TRANSFER_BIT_EXT` | `vkCopyMemoryToImage`로 호스트가 직접 복사(1.4 / `hostImageCopy` feature) |

> **주의** `SAMPLED`로 쓰려면 `vkGetPhysicalDeviceFormatProperties`로 `OPTIMAL_TILING` + `SAMPLED_IMAGE` 비트가 켜져 있는지 확인. 일부 포맷(BGR, 일부 압축 포맷)은 디바이스에 따라 샘플링이 안 될 수 있다.

### 3.5. `samples` — 멀티샘플

- `VK_SAMPLE_COUNT_1_BIT` ~ `64_BIT`. MSAA용 렌더 타깃은 `> 1`로 만든다.
- `samples > 1`이면 **storage/sampled로는 직접 못 쓰고**, resolve 또는 렌더 패스의 multisample attachment로만 사용 가능. 샘플링하려면 먼저 `vkCmdResolveImage`로 1x로 내려야 한다.

### 3.6. `mipLevels` / `arrayLayers`

- `mipLevels`: 1 이상. 0이면 validation 에러(VUID-mipLevels-00947). 풀 밉체인은 `floor(log2(max(w,h)))+1`.
- `arrayLayers`: 1 이상. 0이면 에러(VUID-arrayLayers-00948). 큐브맵은 6의 배수.
- `flags`에 `CUBE_COMPATIBLE_BIT`를 주면 array layer 6개를 큐브면으로 해석 가능.

### 3.7. `initialLayout` — 생성 직후 상태

> **스펙 원문 (VUID-VkImageCreateInfo-initialLayout-00993)** initialLayout must be `VK_IMAGE_LAYOUT_UNDEFINED` or `VK_IMAGE_LAYOUT_PREINITIALIZED` (or `VK_IMAGE_LAYOUT_ZERO_INITIALIZED_EXT`).

- `UNDEFINED`: 내용이 정의되지 않음(쓰레기값). 첫 사용 전 무조건 layout transition 필요. 가장 일반적.
- `PREINITIALIZED`: 호스트에서 이미 데이터를 채워둠. LINEAR + 호스트 쓰기 경로에서 사용. 첫 transition에서 UNDEFINED로 무효화하지 않아도 되므로 약간의 성능 이득.
- `ZERO_INITIALIZED_EXT`: `zeroInitializeDeviceMemory` feature가 켜져 있을 때만. 외부/할당자에서 0으로 초기화되었다고 가정.

### 3.8. `flags` — 자주 쓰는 비트

- `MUTABLE_FORMAT_BIT`: 동일 이미지에서 여러 호환 포맷의 view를 만들 수 있다(SAME_FLAGS 등 호환성 클래스 필요).
- `CUBE_COMPATIBLE_BIT`: 2D 이미지의 array layer 6개를 큐브로 사용.
- `ARRAY_2D_COMPATIBLE_BIT`: 3D 이미지의 2D 슬라이스를 view로 사용(Volumetric shadow map 등).
- `SPARSE_*_BIT`: 스파스 바인딩(드물게 사용).
- `ALIAS_BIT`: 동일 메모리를 다른 이미지로 재바인드.
- `PROTECTED_BIT`: 보안 메모리 + 보안 큐.
- `EXTENDED_USAGE_BIT`: view의 format이 이미지의 format과 다를 때, view가 요구하는 usage도 image usage에 포함시키도록 함.

### 3.9. 일반적인 텍스처 생성 코드

```c
VkImageCreateInfo imgCI{};
imgCI.sType         = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO;
imgCI.imageType     = VK_IMAGE_TYPE_2D;
imgCI.format        = VK_FORMAT_R8G8B8A8_SRGB;
imgCI.extent        = {1024, 1024, 1};
imgCI.mipLevels     = 1;
imgCI.arrayLayers   = 1;
imgCI.samples       = VK_SAMPLE_COUNT_1_BIT;
imgCI.tiling        = VK_IMAGE_TILING_OPTIMAL;
imgCI.usage         = VK_IMAGE_USAGE_TRANSFER_DST_BIT      // 스테이징에서 업로드
                    | VK_IMAGE_USAGE_SAMPLED_BIT;          // 셰이더에서 샘플링
imgCI.sharingMode   = VK_SHARING_MODE_EXCLUSIVE;
imgCI.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;           // 내용은 의미 없음

VkImage texture;
vkCreateImage(device, &imgCI, nullptr, &texture);

VkMemoryRequirements memReqs;
vkGetImageMemoryRequirements(device, texture, &memReqs);

VkMemoryAllocateInfo allocInfo{};
allocInfo.sType           = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
allocInfo.allocationSize  = memReqs.size;
allocInfo.memoryTypeIndex = findMemoryType(memReqs.memoryTypeBits,
    VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);

VkDeviceMemory mem;
vkAllocateMemory(device, &allocInfo, nullptr, &mem);
vkBindImageMemory(device, texture, mem, 0);
```

> **중요** 생성 직후의 `initialLayout`이 `UNDEFINED`이므로, 이 이미지를 샘플링/렌더링하기 전에는 **반드시 `VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL`(또는 적절한 레이아웃)로 transition**해야 한다. 그렇지 않으면 셰이더가 의미 없는(또는 0으로 초기화된) 데이터를 읽게 되거나 validation 에러가 난다. 자세한 건 `레이아웃 전환` 섹션.

---

## 4. `VkImageView` — 이미지 뷰

셰이더가 이미지에 접근하려면 **거의 항상** `VkImageView`가 필요하다. View는 "이 이미지의 어떤 포맷으로, 어떤 mip/array 구간을, 어떤 컴포넌트 매핑으로 볼 것인가"를 정의한다.

```c
typedef struct VkImageViewCreateInfo {
    VkStructureType            sType;
    const void*                pNext;
    VkImageViewCreateFlags     flags;
    VkImage                    image;
    VkImageViewType            viewType;     // 1D/2D/3D/CUBE/CUBE_ARRAY/2D_ARRAY 등
    VkFormat                   format;       // view의 포맷 (MUTABLE_FORMAT 시 다를 수 있음)
    VkComponentMapping         components;   // R/G/B/A 채널 스위즐
    VkImageSubresourceRange    subresourceRange;  // mip range × layer range × aspect
} VkImageViewCreateInfo;
```

### 4.1. `viewType`

| viewType | 의미 |
|----------|------|
| `1D` / `1D_ARRAY` | 1D 이미지 / 1D 배열 |
| `2D` / `2D_ARRAY` | 2D 텍스처(배열) |
| `3D` | 3D 볼륨 텍스처 |
| `CUBE` | 큐브맵(6 layer) |
| `CUBE_ARRAY` | 큐브맵 배열 |
| `2D_ARRAY`의 부분으로 큐브를 쓰면 큐브맵이 된다 |

### 4.2. `subresourceRange` — 어떤 서브리소스를 노출할지

```c
typedef struct VkImageSubresourceRange {
    VkImageAspectFlags  aspectMask;     // COLOR / DEPTH / STENCIL / PLANE_0..2
    uint32_t            baseMipLevel;
    uint32_t            levelCount;     // VK_REMAINING_MIP_LEVELS 가능
    uint32_t            baseArrayLayer;
    uint32_t            layerCount;     // VK_REMAINING_ARRAY_LAYERS 가능
} VkImageSubresourceRange;
```

> **스펙 원문** `aspectMask` must not be 0 (VUID-VkImageSubresourceRange-aspectMask-requiredbitmask).
> `COLOR`는 `PLANE_0..2`와 동시에 설정 불가(VUID-aspectMask-01670). 멀티플랜(YCbCr) 포맷에서 디스크립터로 쓸 때는 `PLANE_i`로 aspect를 줘서 view를 만들어야 한다(VUID-image-.../sampler Y′CBCR conversion 없는 경우).

- `levelCount`가 `VK_REMAINING_MIP_LEVELS`면 base부터 끝까지.
- `layerCount`도 마찬가지. `CUBE`에 `REMAINING_*` 쓰면 남은 레이어 수가 **정확히 6**이어야 하고(VUID-viewType-02962), `CUBE_ARRAY`는 **6의 배수**여야 한다(VUID-viewType-02963).

### 4.3. `components` — 채널 스위즐

```c
typedef struct VkComponentMapping {
    VkComponentSwizzle  r;
    VkComponentSwizzle  g;
    VkComponentSwizzle  b;
    VkComponentSwizzle  a;
} VkComponentMapping;
```

각 컴포넌트를 R/G/B/A/ZERO/ONE 중 하나로 매핑. 예: `BGRA` 데이터를 RGBA로 쓰려면 `{R=B, G=G, B=R, A=A}`. 기본값은 identity.

> **주의** `VK_KHR_portability_subset`이 활성화된 디바이스(일부 Apple/MoltenVK)에서 `imageViewFormatSwizzle`이 `VK_FALSE`이면 identity 스위즐만 허용된다(VUID-VkImageViewCreateInfo-imageViewFormatSwizzle-04465).

### 4.4. view의 `format`은 어떻게 정해지나

- 기본은 이미지의 `format`과 동일.
- `MUTABLE_FORMAT_BIT`로 생성된 이미지라면 **format compatibility class** 안의 다른 포맷을 view format으로 쓸 수 있다(예: `R8G8B8A8_*` ↔ `R8G8B8A8_*`).
- 단, view format이 다르고 `BLOCK_TEXEL_VIEW_COMPATIBLE_BIT`가 없다면, 두 포맷은 **호환**(같은 메모리 배치)이어야 한다.
- 디스크립터/렌더패스에서 view의 usage는 일반적으로 image의 usage를 상속. `VkImageViewUsageCreateInfo`로 **view에만 다른 usage**를 줄 수도 있다(이 경우 image usage의 부분집합이어야 함).

### 4.5. 디퍼스/스텐실의 special case

- 디퍼스/스텐실 포맷에서 view를 framebuffer attachment로 쓸 때, `aspectMask`는 무시되고 두 aspect 모두 사용된다(스펙 NOTE).
- 디스크립터에서 샘플링/로드하는 경우 aspect를 명시해야 한다(`DEPTH` only, `STENCIL` only, `DEPTH|STENCIL`).
- `VkImageStencilUsageCreateInfo`로 스텐실 aspect에 한정된 별도 usage를 줄 수 있다 → stencil aspect view의 implicit usage는 stencil usage로 결정된다.

---

## 5. 복사 명령 (Copy Commands)

복사 명령은 `vkCmdCopy*` / `vkCmdBlitImage` / `vkCmdResolveImage` 패밀리로, **커맨드 버퍼 안에서** 실행된다. 렌더 패스 안에서는 호출 불가(VUID-renderpass).

### 5.1. 공통 전제

- src/dst 모두 같은 `VkDevice`에서 생성되어야 한다(VUID-commonparent).
- src/dst의 `usage` 플래그에 `TRANSFER_SRC` / `TRANSFER_DST`가 켜져 있어야 한다.
  - `vkCmdCopyBuffer`의 src는 `TRANSFER_SRC`, dst는 `TRANSFER_DST` 필수(VUID-srcBuffer-00118 / dstBuffer-00120).
- `vkCmdBlitImage`는 graphics 큐에서만, `vkCmdCopyImage`는 graphics/compute/transfer 큐에서 호출 가능하다.
- **`vkCmdCopyBuffer`는 non-sparse 버퍼는 단일 `VkDeviceMemory`에 fully-bound** 상태여야 한다(VUID-srcBuffer-00119 / dstBuffer-00121).
- sync2 / `VK_KHR_copy_commands2`를 쓰면 `vkCmdCopy*2` / `Vk*Info2` 구조체로 확장 가능한 변종을 쓸 수 있다.

### 5.2. `vkCmdCopyBuffer` — 버퍼 ↔ 버퍼

```c
void vkCmdCopyBuffer(
    VkCommandBuffer    commandBuffer,
    VkBuffer           srcBuffer,
    VkBuffer           dstBuffer,
    uint32_t           regionCount,
    const VkBufferCopy* pRegions);
```

`VkBufferCopy`: `{ srcOffset, dstOffset, size }`. `size > 0`, `srcOffset + size <= srcBuffer.size`, `dstOffset + size <= dstBuffer.size`.

> **스펙 원문 (VUID-vkCmdCopyBuffer-pRegions-00117)** The union of the source regions, and the union of the destination regions, specified by the elements of pRegions, must not overlap in memory.
>> **소스 영역끼리도, 목적지 영역끼리도 메모리상 겹치면 안 된다.** 같은 버퍼 안에서 일부를 옮기는 in-place 복사도 금지. in-place가 필요하면 staging 버퍼를 경유해야 한다.

| 제약 | 값 |
|------|-----|
| `srcOffset` / `dstOffset` / `size` | 각각 src/dst 버퍼 크기 이내 |
| `size` | > 0 |
| 소스 영역끼리 / 목적지 영역끼리 | **메모리상 겹침 금지** |
| src/dst usage | `TRANSFER_SRC` / `TRANSFER_DST` |
| 큐 | graphics / compute / transfer |

### 5.3. `vkCmdCopyImage` — 이미지 ↔ 이미지

```c
typedef struct VkImageCopy {
    VkImageSubresourceLayers  srcSubresource;
    VkOffset3D                srcOffset;
    VkImageSubresourceLayers  dstSubresource;
    VkOffset3D                dstOffset;
    VkExtent3D                extent;
} VkImageCopy;
```

> **스펙 원문** "Copy regions for the image must be aligned to a multiple of the texel block extent in each dimension..." — 이미지 복사 영역의 오프셋과 익스텐트는 **포맷의 texel block 크기의 배수**여야 한다. 압축 포맷(BC/ASTC/ETC)은 블록 단위로 정렬된다.

- 큐 패밀리 granularity(`VkQueueFamilyProperties`의 `minImageTransferGranularity`)를 따라야 할 수 있다.
- `srcSubresource`와 `dstSubresource`의 `aspectMask`는 **같은 aspect 한 비트**만 가질 수 있다(VUID-aspectMask-...).
- 멀티플랜 포맷은 `PLANE_i`로 각 plane을 따로 복사.
- 큐브 → 큐브 등 layer 차원 매핑은 가능. `imageExtent`는 subresource 차원을 넘을 수 없다.

### 5.4. `vkCmdCopyBufferToImage` / `vkCmdCopyImageToBuffer` — 버퍼 ↔ 이미지

```c
typedef struct VkBufferImageCopy {
    VkDeviceSize                bufferOffset;       // staging 버퍼 안의 시작
    uint32_t                    bufferRowLength;    // 0이면 tightly packed
    uint32_t                    bufferImageHeight;  // 0이면 tightly packed
    VkImageSubresourceLayers    imageSubresource;   // aspect 1비트만
    VkOffset3D                  imageOffset;        // texel 단위
    VkExtent3D                  imageExtent;        // texel 단위, 모두 > 0
} VkBufferImageCopy;
```

> **스펙 원문 (VUID-VkBufferImageCopy-aspectMask-09103)** `imageSubresource.aspectMask` must only have a single bit set.
> **VUID-VkBufferImageCopy-bufferRowLength-09101)** `bufferRowLength` must be 0, or greater than or equal to the width member of `imageExtent`.
> **VUID-VkBufferImageCopy-bufferImageHeight-09102)** `bufferImageHeight` must be 0, or greater than or equal to the height member of `imageExtent`.

- `bufferOffset`은 **포맷의 texel block size**의 배수여야 한다(압축 포맷의 경우). 깊이/스텐실 포맷이면 추가로 4의 배수(VUID-srcBuffer-07978 / VUID-dstImage-07978). 멀티플랜이면 plane의 element size 배수(VUID-dstImage-07976).
- `bufferRowLength` / `bufferImageHeight`는 staging 안에서 **더 큰 가상 2D/3D 데이터의 stride**를 지정한다. 둘 다 0이면 tightly packed(=이미지 extent와 동일 stride).
- `imageOffset` / `imageExtent`는 texel 단위.

**텍스처 업로드 패턴:**

```c
// 1. staging 버퍼에 tightly packed RGBA8 픽셀을 memcpy
// 2. vkCmdCopyBufferToImage로 텍스처의 TRANSFER_DST 레이아웃으로 복사
// 3. 이후 vkCmdPipelineBarrier로 SHADER_READ_ONLY_OPTIMAL로 transition
VkBufferImageCopy region{};
region.bufferOffset      = 0;
region.bufferRowLength   = texWidth;            // 또는 0
region.bufferImageHeight = texHeight;           // 또는 0
region.imageSubresource  = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};  // mip 0, baseArrayLayer 0, 1 layer
region.imageOffset       = {0, 0, 0};
region.imageExtent       = {texWidth, texHeight, 1};

vkCmdCopyBufferToImage(cmd, stagingBuffer, textureImage,
    VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
```

### 5.5. `vkCmdBlitImage` — 스케일/포맷 변환 복사

```c
void vkCmdBlitImage(
    VkCommandBuffer   commandBuffer,
    VkImage           srcImage, VkImageLayout srcImageLayout,
    VkImage           dstImage, VkImageLayout dstImageLayout,
    uint32_t          regionCount,
    const VkImageBlit* pRegions,
    VkFilter          filter);
```

`VkImageBlit`은 src/dst 각각 `subresource` + `offsets[2]`(박스 두 꼭짓점) 형태. 박스 크기가 다르면 **스케일 + 필터링**을 한다.

> **스펙 원문 (vkCmdBlitImage)** "vkCmdBlitImage must not be used for multisampled source or destination images. Use vkCmdResolveImage for this purpose."
>> **MSAA 이미지는 blit의 src/dst가 될 수 없다.** 멀티샘플은 resolve로만 풀어낸다.

- 큐는 **graphics**만 지원(VUID-commandBuffer-cmdpool → `VK_QUEUE_GRAPHICS_BIT`).
- 포맷 변환: src/dst의 **texel 크기가 같은** 포맷끼리만 가능(예: `R8G8B8A8_UNORM` → `R8G8B8A8_SRGB`은 OK, `R8G8B8A8` ↔ `B8G8R8A8`은 component reinterpretation 필요). 일반적인 RGB↔RGBA 같은 size mismatch는 불가.
- 큐브/3D 매핑 등 layer 차원 매핑은 추가 제약이 있다.
- `filter`는 스케일이 필요할 때만 사용. `NEAREST`가 안전하고 빠르다. `LINEAR`는 큐브의 경우 디바이스에서 지원하지 않을 수 있다. `CUBIC_EXT`는 별도 feature.

### 5.6. `vkCmdResolveImage` — MSAA → 1x

```c
void vkCmdResolveImage(
    VkCommandBuffer    commandBuffer,
    VkImage            srcImage, VkImageLayout srcImageLayout,
    VkImage            dstImage, VkImageLayout dstImageLayout,
    uint32_t           regionCount,
    const VkImageResolve* pRegions);
```

`VkImageResolve`: `{ srcSubresource, dstSubresource, srcOffset, dstOffset, extent }`. Blit과 달리 박스 크기가 같아야 한다(=복사). 두 이미지의 `format`은 같아야 하고, src는 MSAA여야 하며 dst는 1x여야 한다.

### 5.7. Mipmap 생성 패턴

가장 일반적인 텍스처 로딩 순서:

```c
// 1. 텍스처는 usage에 TRANSFER_DST | TRANSFER_SRC | SAMPLED, mipLevels = N
// 2. 초기 layout = UNDEFINED
// 3. 첫 barrier: UNDEFINED -> TRANSFER_DST_OPTIMAL
// 4. vkCmdCopyBufferToImage로 mip 0 업로드
// 5. for (i = 0; i+1 < N; ++i) {
//      barrier: mip i를 TRANSFER_DST -> TRANSFER_SRC
//      vkCmdBlitImage(src=mip i, dst=mip i+1, filter=LINEAR)
//      barrier: mip i+1를 TRANSFER_SRC -> SHADER_READ_ONLY_OPTIMAL
//    }
// 6. 마지막 mip N-1: TRANSFER_DST -> SHADER_READ_ONLY_OPTIMAL
```

> **스펙 주의** `vkCmdBlitImage`의 src/dst는 같은 `VkDevice`여야 하고, 두 이미지가 같아도 된다(같은 이미지의 mip 간 blit도 가능). 단 src/dst subresource는 **서로 다른 mip level**이어야 한다.

`vkCmdBlitImage` 대신 `vkCmdCopyImage`(스케일 없이 정확한 박스)로 mip을 만들 수도 있지만, 이 경우 업로드 데이터를 mip별로 다 준비해야 한다. blit이 일반적.

### 5.8. `vkCmdUpdateBuffer` / `vkCmdFillBuffer` — 작은 버퍼 갱신

- `vkCmdFillBuffer`: 버퍼의 일정 범위를 4바이트 단위 값으로 채움. `dstBuffer`에 `TRANSFER_DST` 필요.
- `vkCmdUpdateBuffer`: 65536바이트 이하 데이터를 4바이트 정렬된 오프셋에 기록. `dstBuffer`에 `TRANSFER_DST` 필요. **size는 4의 배수**.

둘 다 `vkCmdCopyBuffer`보다 가볍지만, 큰 데이터에는 부적합.

---

## 6. 큐 패밀리 소유권 이전 (Queue Family Ownership Transfer)

같은 리소스를 다른 큐 패밀리가 사용하려면 **소유권 이전**이 필요하다. 방법은 두 가지.

### 6.1. 배리어를 통한 release / acquire

다음 예제에서 `gfxFamily` / `TRANSFER_FAMILY`는 **각 큐 패밀리의 family index**를 나타내는 플레이스홀더다. 실제 값은 디바이스의 `vkGetPhysicalDeviceQueueFamilyProperties`로 알아내야 한다.

```c
// graphics 큐가 다 쓴 뒤 transfer 큐로 넘기는 예
void releaseFromGraphics(VkCommandBuffer gfxCmd, VkImage image, uint32_t gfxFamily) {
    VkImageMemoryBarrier bar{};
    bar.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER;
    bar.srcAccessMask = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
    bar.dstAccessMask = 0;            // release 측
    bar.oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
    bar.newLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
    bar.srcQueueFamilyIndex = gfxFamily;
    bar.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;  // release
    bar.image = image;
    bar.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};

    vkCmdPipelineBarrier(gfxCmd,
        VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
        VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT,
        0, 0, nullptr, 0, nullptr, 1, &bar);
}

void acquireOnTransfer(VkCommandBuffer xferCmd, VkImage image) {
    VkImageMemoryBarrier bar{};
    bar.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER;
    bar.srcAccessMask = 0;
    bar.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
    bar.oldLayout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
    bar.newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;  // 필요 시 동시 레이아웃 전환
    bar.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;      // acquire
    bar.dstQueueFamilyIndex = TRANSFER_FAMILY;
    bar.image = image;
    bar.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};

    vkCmdPipelineBarrier(xferCmd,
        VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,
        VK_PIPELINE_STAGE_TRANSFER_BIT,
        0, 0, nullptr, 0, nullptr, 1, &bar);
}
```

> **스펙 원문 (VUID-vkCmdPipelineBarrier-srcQueueFamilyIndex-10388)** If a buffer or image memory barrier specifies a queue family ownership transfer operation, either the `srcQueueFamilyIndex` or `dstQueueFamilyIndex` and the queue family index that was used to create the command pool that `commandBuffer` was allocated from must be equal.
>> release 배리어는 **소스 큐 패밀리의 커맨드 풀**에서 기록되어야 하고, acquire 배리어는 **목적지 큐 패밀리의 커맨드 풀**에서 기록되어야 한다.

- 한쪽을 `VK_QUEUE_FAMILY_IGNORED`로 두면 release(소스가 풀에 속함) / acquire(목적이 풀에 속함)가 결정된다.

### 6.2. `CONCURRENT` sharingMode

생성 시 `sharingMode = VK_SHARING_MODE_CONCURRENT`로 두면 큐 패밀리 배리어를 명시적으로 안 써도 된다. 단, 사용 시점에 두 큐가 동시에 같은 서브리소스를 읽는 일은 막을 수 없으므로, 보통은 **명시적 release/acquire**가 더 안전하고 빠르다.

> **실전 권장** 단일 큐 또는 graphics+present 정도만 쓸 거면 `EXCLUSIVE` + release/acquire 조합이 깔끔하다. 그래픽스 ↔ 컴퓨트처럼 자주 왕복하는 경로도 `EXCLUSIVE`로 충분하다. `CONCURRENT`는 정말 동시에 두 큐가 같은 리소스를 다뤄야 할 때만.

---

## 7. 자주 빠지는 주의사항 모음

> **이 섹션은 "왜 안 되지?"가 나왔을 때 가장 먼저 보는 곳이다.** 항목마다 짧게 사유 + 스펙 VUID를 명시했다.

### 7.1. 생성 단계

- [ ] `usage` / `size` 누락. `usage == 0`이거나 `size == 0`이면 `vkCreateBuffer` 실패(VUID-None-09500 / VUID-size-00912).
- [ ] 이미지에서 `mipLevels=0` 또는 `arrayLayers=0` (VUID-mipLevels-00947 / VUID-arrayLayers-00948).
- [ ] `extent.width/height/depth = 0` (VUID-extent-...-00944..00946).
- [ ] 압축 포맷을 `LINEAR` tiling으로 생성 (VUID-tiling-02261).
- [ ] YCbCr 포맷을 `mipLevels > 1` / `samples > 1` / 1D, 3D로 생성 (VUID-format-06410..06412).
- [ ] `CUBE_COMPATIBLE_BIT`인데 `imageType != 2D` 또는 `arrayLayers`가 6의 배수가 아님.
- [ ] `samples > 1`인데 `SAMPLED` / `STORAGE`를 동시에 켬.
- [ ] `initialLayout`에 `UNDEFINED`/`PREINITIALIZED`/`ZERO_INITIALIZED_EXT` 외의 값. 외부 메모리 핸들 사용 시 `UNDEFINED` 강제(VUID-pNext-01443).
- [ ] `STORAGE` usage에 `STORAGE_IMAGE` 포맷 피처가 없는 경우. `vkGetPhysicalDeviceFormatProperties`로 사전 확인.
- [ ] `UNIFORM_BUFFER` / `STORAGE_BUFFER` / `*_TEXEL_BUFFER` 사용 시 dynamic offset의 alignment(`minUniformBufferOffsetAlignment` 등).

### 7.2. 뷰 / 디스크립터 단계

- [ ] `subresourceRange.aspectMask = 0` (VUID-aspectMask-requiredbitmask).
- [ ] 멀티플랜(YCbCr)인데 `COLOR` aspect로 디스크립터 view 생성. `PLANE_0..2`로 줘야 함.
- [ ] `CUBE` view에 `REMAINING_*`를 줬는데 남은 레이어가 6이 아님 / `CUBE_ARRAY`가 6의 배수가 아님 (VUID-viewType-02962/02963).
- [ ] `MUTABLE_FORMAT_BIT` 없이 다른 포맷의 view 생성.
- [ ] 디퍼스/스텐실에서 `DEPTH|STENCIL`을 디스크립터에 동시에 → 실제로는 두 aspect 각각의 단일 view를 별도로 만들어야 한다.
- [ ] 디스크립터 바인딩 후 `vkUpdateDescriptorSets`로 set을 갱신해 command buffer를 invalid (Update-After-Bind 미사용 시).

### 7.3. 복사 단계

- [ ] `vkCmdCopyBuffer`의 `usage`에 `TRANSFER_SRC` / `TRANSFER_DST` 누락 (VUID-srcBuffer-00118/00119 / VUID-dstBuffer-00120/00121).
- [ ] `vkCmdCopyBuffer`에서 src 영역끼리 / dst 영역끼리 메모리상 겹침 (VUID-pRegions-00117).
- [ ] `vkCmdCopyBufferToImage`의 `bufferOffset`이 압축/멀티플랜/디퍼스-스텐실 포맷의 element/texel block size의 배수가 아님 (VUID-srcBuffer-07976..07978).
- [ ] `vkCmdCopyImage`의 오프셋/익스텐트가 texel block 단위로 정렬되지 않음.
- [ ] `vkCmdBlitImage`에 MSAA 이미지를 src/dst로 사용 (스펙 명시 금지 → `vkCmdResolveImage` 사용).
- [ ] `vkCmdBlitImage`에서 큐 family가 graphics가 아님 (VUID-cmdpool).
- [ ] `vkCmdBlitImage`에서 큐브 face를 2D array layer와 매핑하는 등 layer 차원 매핑이 맞지 않음.
- [ ] `vkCmdResolveImage`에서 src와 dst의 `samples`가 다르게 설정되지 않음(MSAA vs 1x), 또는 `format`이 다름.
- [ ] `vkCmdCopy*`를 렌더 패스 안에서 호출 (VUID-renderpass).
- [ ] `vkCmdCopy*`를 호출할 때 이미지 레이아웃이 잘못됨(예: `TRANSFER_SRC`로 읽는데 `SHADER_READ_ONLY_OPTIMAL`).

### 7.4. 동기화 / 레이아웃 단계

- [ ] `UNDEFINED`에서 생성된 이미지를 첫 사용 전 레이아웃 전환 안 함.
- [ ] `SAMPLED`로 쓰려는 이미지를 `SHADER_READ_ONLY_OPTIMAL`로 전환 안 함.
- [ ] `COLOR_ATTACHMENT`로 쓰려는 이미지를 `COLOR_ATTACHMENT_OPTIMAL`로 전환 안 함. attachment → sampled로 다시 읽으려면 `SHADER_READ_ONLY_OPTIMAL`로 또 transition.
- [ ] `vkCmdPipelineBarrier`의 src/dst stage가 해당 큐 패밀리에서 지원되지 않는 stage (VUID-srcStageMask-06461 / VUID-dstStageMask-06462).
- [ ] `srcQueueFamilyIndex` / `dstQueueFamilyIndex`를 둘 다 `IGNORED`가 아닌 다른 값으로 둘 때, release 배리어를 소스 큐 풀에서 / acquire 배리어를 목적지 풀에서 기록하지 않음 (VUID-srcQueueFamilyIndex-10388).
- [ ] `HOST_BIT`을 stage로 쓸 때 queue family ownership transfer를 같이 사용 (VUID-srcStageMask-09633/09634 → `HOST_BIT` 사용 시 src/dstQueueFamilyIndex가 같아야 함).

### 7.5. 디스크립터 / 셰이더 단계

- [ ] 디스크립터의 `imageLayout`(디스크립터 업데이트 시) / 현재 이미지 레이아웃 불일치.
- [ ] `STORAGE_IMAGE`에 `STORAGE` usage가 없거나, format feature에 `STORAGE_IMAGE` 비트가 없음.
- [ ] `COMBINED_IMAGE_SAMPLER`에 `SAMPLED_BIT`만 있는 sampler를 쓰면서 별도 sampler를 또 묶음(중복 바인딩).
- [ ] `sampler`의 `unnormalizedCoordinates` + view의 비-2D viewType.
- [ ] 셰이더에서 `texture(sampler2D, uv)`로 샘플링하는데, `unnormalizedCoordinates = VK_TRUE`인 sampler를 사용.

---

## 8. 빠른 참조 — 한 표로 보는 리소스 흐름

> **큐 약어**: `gfx` = graphics 큐, `comp` = compute 큐, `xfer` = 전용 transfer(전송) 큐. 슬래시(`/`)는 "OR"로, 여러 큐에서 호출 가능하다는 뜻.

| 작업 | 사용 API | 사용 플래그 (src / dst) | 큐 |
|------|----------|----------------------|----|
| 정점 버퍼 채우기 | `vkCmdCopyBuffer` | `TRANSFER_SRC` / `TRANSFER_DST` | gfx/comp/xfer |
| 인덱스 버퍼 채우기 | `vkCmdCopyBuffer` | `TRANSFER_SRC` / `TRANSFER_DST` | gfx/comp/xfer |
| 텍스처 업로드 | `vkCmdCopyBufferToImage` | `TRANSFER_SRC` / `TRANSFER_DST` (이미지) | gfx/comp/xfer |
| 텍스처 readback | `vkCmdCopyImageToBuffer` | `TRANSFER_SRC` (이미지) / `TRANSFER_DST` | gfx/comp/xfer |
| 이미지 → 이미지 복사 | `vkCmdCopyImage` | `TRANSFER_SRC` / `TRANSFER_DST` | gfx/comp/xfer |
| 스케일/포맷 변환 복사 | `vkCmdBlitImage` | `TRANSFER_SRC` / `TRANSFER_DST` | gfx only |
| Mipmap 생성 | `vkCmdBlitImage` (같은 이미지의 mip 간) | `TRANSFER_SRC` / `TRANSFER_DST` | gfx only |
| MSAA → 1x 다운샘플 | `vkCmdResolveImage` | `TRANSFER_SRC` / `TRANSFER_DST` (dst는 1x) | gfx only |
| 작은 영역 채우기 | `vkCmdFillBuffer` / `vkCmdUpdateBuffer` | - / `TRANSFER_DST` | gfx/comp/xfer |
| 큐 패밀리 이동 | `vkCmdPipelineBarrier` (release + acquire) | queue family mask | 두 큐 모두 |
