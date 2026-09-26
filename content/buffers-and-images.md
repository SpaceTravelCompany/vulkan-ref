---
title: 버퍼 & 이미지
slug: buffers-and-images
---

## 소개

Vulkan의 핵심 GPU 리소스는 1차원 선형 메모리인 **버퍼(`VkBuffer`)**와 다차원 텍셀 구조인 **이미지(`VkImage`)** 두 가지로 나뉜다. 정점, 인덱스, 균일/저장 버퍼 등은 버퍼로 구성하며, 텍스처, 렌더 타깃, 깊이/스텐실 버퍼 등은 이미지로 구성한다.

> **용어 정리**
> - **버퍼(Buffer)**: 연속된 바이트 배열. 디스크립터로 바인딩하거나 `vkCmdCopy*` 명령으로 복사하여 사용.
> - **이미지(Image)**: 다차원 텍셀 배열. 셰이더에서 샘플링하거나 렌더 타깃으로 쓰려면 반드시 `VkImageView`를 거쳐야 함.
> - **서브리소스(Subresource)**: 이미지 내의 특정 밉 레벨, 배열 레이어, 애스펙트(색상/깊이/스텐실)의 조합.
> - **레이아웃(Layout)**: GPU 하드웨어가 이미지를 어떤 용도로 캐싱하고 압축할지 정의하는 상태. 잘못된 레이아웃에서 접근하면 렌더링 왜곡이나 크래시가 발생.

이 문서는 버퍼와 이미지의 **생성 → 뷰 설정 → 복사 및 소유권 이전** 흐름과 실무 주의사항을 정리한다.

---

## 1. 전체 흐름

```flowchart
flowchart TD
  A["VkBuffer / VkImage 핸들 생성"]
  B(["vkGet*MemoryRequirements — 메모리 크기 및 타입 조회"])
  C(["VkDeviceMemory 할당 + vkBind*Memory 바인딩"])
  D["(이미지 전용) VkImageView 생성"]
  E(["커맨드 기록: 복사 / 레이아웃 전환 / 디스크립터 갱신 / 바인딩"])
  F(["리소스 해제: View 파괴 → Image/Buffer 파괴 → Memory 해제"])
  A --> B --> C --> D --> E --> F
```

**핵심 요약:**
- 리소스 핸들(`VkBuffer`, `VkImage`)을 생성해도 실제 GPU 메모리가 자동으로 할당되지 않는다. 메모리 요구사항을 질의하여 적절한 `VkDeviceMemory`를 할당하고 `vkBind*Memory`로 연결해야 GPU가 접근할 수 있다.
- 이미지는 디스크립터나 프레임버퍼에 raw 핸들을 직접 넘길 수 없으며, 거의 모든 경우 `VkImageView`를 경유한다.
- 레이아웃(Layout)은 이미지에만 존재하며, 버퍼에는 레이아웃 개념이 없다.

---

## 2. `VkBuffer` — 버퍼 생성

`vkCreateBuffer`로 핸들을 만든 후 메모리를 할당하여 바인딩한다.

```c
typedef struct VkBufferCreateInfo {
    VkStructureType        sType;
    const void*            pNext;
    VkBufferCreateFlags    flags;
    VkDeviceSize           size;                  // 0보다 커야 함 (VUID-size-00912)
    VkBufferUsageFlags     usage;                 // 0이면 안 됨 (VUID-None-09500)
    VkSharingMode          sharingMode;           // EXCLUSIVE 또는 CONCURRENT
    uint32_t               queueFamilyIndexCount;
    const uint32_t*        pQueueFamilyIndices;
} VkBufferCreateInfo;
```

### 2.1. `usage` 플래그

버퍼 생성 시 해당 버퍼가 거치게 될 모든 용도를 비트 OR로 선언해야 한다.

| 플래그 | 주요 용도 |
|--------|----------|
| `TRANSFER_SRC` | 복사 소스 버퍼 (`vkCmdCopyBuffer`, `vkCmdCopyBufferToImage`) |
| `TRANSFER_DST` | 복사 대상 버퍼, 데이터 지우기 (`vkCmdFillBuffer`) |
| `VERTEX_BUFFER` | 정점 속성 버퍼 (`vkCmdBindVertexBuffers`) |
| `INDEX_BUFFER` | 인덱스 버퍼 (`vkCmdBindIndexBuffer`) |
| `UNIFORM_BUFFER` | 균일 버퍼(UBO). `minUniformBufferOffsetAlignment` 정렬 필요 |
| `STORAGE_BUFFER` | 저장 버퍼(SSBO). `minStorageBufferOffsetAlignment` 정렬 필요 |
| `UNIFORM_TEXEL_BUFFER` | 텍셀 단위 읽기 전용 버퍼 뷰 |
| `STORAGE_TEXEL_BUFFER` | 텍셀 단위 읽기/쓰기 저장 버퍼 뷰 |
| `INDIRECT_BUFFER` | 간접 드로우/디스패치 명령 버퍼 |
| `SHADER_DEVICE_ADDRESS` | 셰이더 내 64비트 버퍼 주소 직접 참조 |

### 2.2. `sharingMode` — 큐 패밀리 공유 방식

- `EXCLUSIVE`(권장 기본값): 한 번에 하나의 큐 패밀리만 접근한다. 드라이버 오버헤드가 가장 적고 대부분의 시나리오에 적합하다. 큐 간 이동 시 파이프라인 배리어로 소유권을 명시적으로 이전한다.
- `CONCURRENT`: 여러 큐 패밀리가 동시에 접근한다. `queueFamilyIndexCount >= 2`여야 하며 큐 간 소유권 이전 배리어는 생략할 수 있으나 드라이버의 내부 추적 비용이 증가한다.

### 2.3. 전형적인 정점 버퍼 생성 코드

```c
VkBufferCreateInfo bufCI{};
bufCI.sType       = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
bufCI.size        = vertexDataSize;
bufCI.usage       = VK_BUFFER_USAGE_VERTEX_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
bufCI.sharingMode = VK_SHARING_MODE_EXCLUSIVE;

VkBuffer vertexBuffer;
vkCreateBuffer(device, &bufCI, nullptr, &vertexBuffer);

VkMemoryRequirements memReqs;
vkGetBufferMemoryRequirements(device, vertexBuffer, &memReqs);

VkMemoryAllocateInfo allocInfo{};
allocInfo.sType           = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
allocInfo.allocationSize  = memReqs.size;
allocInfo.memoryTypeIndex = findMemoryType(memReqs.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);

VkDeviceMemory mem;
vkAllocateMemory(device, &allocInfo, nullptr, &mem);
vkBindBufferMemory(device, vertexBuffer, mem, 0);
```

---

## 3. `VkImage` — 이미지 생성

```c
typedef struct VkImageCreateInfo {
    VkStructureType          sType;
    const void*              pNext;
    VkImageCreateFlags       flags;
    VkImageType              imageType;       // 1D, 2D, 3D
    VkFormat                 format;          // 텍셀 포맷
    VkExtent3D               extent;          // 가로, 세로, 깊이 (> 0)
    uint32_t                 mipLevels;       // 밉 레벨 수 (>= 1)
    uint32_t                 arrayLayers;     // 레이어 수 (>= 1)
    VkSampleCountFlagBits    samples;         // MSAA 샘플 수 (1_BIT ~ 64_BIT)
    VkImageTiling            tiling;          // OPTIMAL 또는 LINEAR
    VkImageUsageFlags        usage;
    VkSharingMode            sharingMode;
    uint32_t                 queueFamilyIndexCount;
    const uint32_t*          pQueueFamilyIndices;
    VkImageLayout            initialLayout;   // UNDEFINED 또는 PREINITIALIZED
} VkImageCreateInfo;
```

### 3.1. 핵심 설정 요약

- **`tiling`**:
  - `OPTIMAL`: GPU 하드웨어에 최적화된 내부 타일링 구조. 렌더링 및 텍스처 샘플링에 사용한다.
  - `LINEAR`: 메모리가 행(Row) 단위로 선형 정렬된다. CPU 직접 쓰기/읽기 경로에만 쓰이며 2D, 1 mip, 1 layer 등 제약이 매우 강하다.
- **`usage`**:
  - `SAMPLED`: 셰이더에서 텍스처로 샘플링.
  - `STORAGE`: 셰이더 내 이미지 로드/스토어.
  - `COLOR_ATTACHMENT` / `DEPTH_STENCIL_ATTACHMENT`: 렌더 패스 첨부물.
  - `INPUT_ATTACHMENT`: 서브패스 입력(서브패스에서 픽셀 단위로 읽기).
  - `TRANSFER_SRC` / `TRANSFER_DST`: 복사 명령의 소스 또는 대상.
  - `TRANSIENT_ATTACHMENT`: `LAZILY_ALLOCATED` 메모리와 함께 쓰는 임시 첨부. 이 플래그가 포함된 이미지는 다른 usage와 조합할 수 없다(VUID-VkImageCreateInfo-usage-00963).
  - `SHADING_RATE_IMAGE_BIT_NV` / `FRAGMENT_SHADING_RATE_ATTACHMENT_BIT_KHR`: 셰이딩 레이트 특수 용도.
  - `HOST_TRANSFER_BIT_EXT`: `vkCopyMemoryToImage`로 호스트가 직접 복사(Vulkan 1.4 / `hostImageCopy` 피처).
- **`initialLayout`**:
  - `UNDEFINED`: 초기 내용이 쓰레기값이다. 첫 사용 전 배리어로 적절한 레이아웃으로 전환해야 한다. 가장 일반적인 설정이다.
  - `PREINITIALIZED`: 호스트 메모리에서 사전에 데이터를 채운 경우 첫 전환 시 내용을 보존할 때 사용한다. LINEAR 타일링 이미지에만 유용하다.
  - `ZERO_INITIALIZED_EXT`: `zeroInitializeDeviceMemory` 피처가 활성화되어 있을 때만 사용 가능. 외부/할당자에서 0으로 초기화되었다고 가정한다.

### 3.2. 포맷 (`format`)

- 생성 전 `vkGetPhysicalDeviceFormatProperties`로 해당 포맷이 요구하는 usage 비트를 지원하는지 확인해야 한다. 특히 `SAMPLED`로 쓰려면 `OPTIMAL_TILING` + `SAMPLED_IMAGE` 비트가 켜져 있는지 점검한다.
- `VK_FORMAT_UNDEFINED`는 pNext의 `VkExternalFormatANDROID` 같은 외부 포맷 구조체와 함께만 쓸 수 있다(VUID-format-01975).
- `_422`/`_420` suffix 포맷은 `extent.width`가 2의 배수, `_420`은 `extent.height`도 2의 배수여야 한다. YCbCr 변환이 필요한 포맷은 `imageType=2D`, `mipLevels=1`, `arrayLayers=1`(ycbcrImageArrays 활성화 시 예외), `samples=1_BIT`이 강제된다.

### 3.3. 텍스처 이미지 생성 예시

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
imgCI.usage         = VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_SAMPLED_BIT;
imgCI.sharingMode   = VK_SHARING_MODE_EXCLUSIVE;
imgCI.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;

VkImage textureImage;
vkCreateImage(device, &imgCI, nullptr, &textureImage);

// 메모리 요구사항 조회 → 할당 → 바인딩
VkMemoryRequirements memReqs;
vkGetImageMemoryRequirements(device, textureImage, &memReqs);

VkMemoryAllocateInfo allocInfo{};
allocInfo.sType           = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
allocInfo.allocationSize  = memReqs.size;
allocInfo.memoryTypeIndex = findMemoryType(memReqs.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);

VkDeviceMemory mem;
vkAllocateMemory(device, &allocInfo, nullptr, &mem);
vkBindImageMemory(device, textureImage, mem, 0);
```

> [!WARNING]
> `initialLayout`이 `VK_IMAGE_LAYOUT_UNDEFINED`이므로, 이 이미지를 샘플링하거나 렌더 타깃으로 사용하기 전에 **반드시 적절한 레이아웃으로 전환**해야 한다(예: `VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL`). 전환 없이 사용하면 정의되지 않은 동작이다.

---

## 4. `VkImageView` — 이미지 뷰

셰이더나 프레임버퍼가 이미지에 접근할 때 사용할 뷰 타입, 포맷, 서브리소스 범위, 채널 스위즐을 정의한다.

```c
typedef struct VkImageViewCreateInfo {
    VkStructureType            sType;
    const void*                pNext;
    VkImageViewCreateFlags     flags;
    VkImage                    image;
    VkImageViewType            viewType;     // 1D, 2D, 3D, CUBE, 2D_ARRAY 등
    VkFormat                   format;
    VkComponentMapping         components;   // R/G/B/A 채널 스위즐
    VkImageSubresourceRange    subresourceRange;
} VkImageViewCreateInfo;
```

**서브리소스 범위 (`VkImageSubresourceRange`):**

```c
VkImageSubresourceRange range{};
range.aspectMask     = VK_IMAGE_ASPECT_COLOR_BIT;  // 색상 애스펙트
range.baseMipLevel   = 0;
range.levelCount     = 1;                          // VK_REMAINING_MIP_LEVELS 가능
range.baseArrayLayer = 0;
range.layerCount     = 1;                          // VK_REMAINING_ARRAY_LAYERS 가능
```

- 큐브맵 뷰(`CUBE`)는 `layerCount`가 반드시 6이어야 하며(VUID-viewType-02960), 큐브 배열(`CUBE_ARRAY`)은 6의 배수여야 한다(VUID-viewType-02963).
- 깊이/스텐실 이미지를 디스크립터에서 샘플링할 때는 사용할 애스펙트(`DEPTH_BIT` 또는 `STENCIL_BIT`)를 개별 뷰로 분리하여 지정해야 한다.

**채널 스위즐 (`VkComponentMapping`):**

각 컴포넌트를 R/G/B/A/ZERO/ONE 중 하나로 매핑한다. 예: `BGRA` 데이터를 RGBA로 쓰려면 `{R=B, G=G, B=R, A=A}`. 기본값은 identity. `VK_KHR_portability_subset`이 활성화된 일부 디바이스(MoltenVK 등)에서 `imageViewFormatSwizzle`이 `VK_FALSE`이면 identity 스위즐만 허용된다(VUID-VkImageViewCreateInfo-imageViewFormatSwizzle-04465).

**뷰 포맷과 호환성:**

- 기본은 이미지의 `format`과 동일하다.
- `MUTABLE_FORMAT_BIT`로 생성된 이미지라면 **format compatibility class** 안의 다른 포맷을 view format으로 쓸 수 있다.
- `VkImageViewUsageCreateInfo`를 pNext에 체이닝하면 view에만 다른 usage를 줄 수 있다(이미지 usage의 부분집합이어야 함).

**`VkImageStencilUsageCreateInfo`:**

스텐실 애스펙트에 한정된 별도 usage를 줄 수 있다. 이 구조체를 사용하면 스텐실 애스펙트 뷰의 암묵적 usage는 stencil usage로 결정된다.

**주요 Create Flags:**

| 플래그 | 설명 |
|--------|------|
| `MUTABLE_FORMAT_BIT` | 동일 이미지에서 여러 호환 포맷의 뷰 생성 가능 |
| `CUBE_COMPATIBLE_BIT` | 2D 이미지의 array layer 6개를 큐브맵으로 사용 |
| `2D_ARRAY_COMPATIBLE_BIT` | 3D 이미지의 2D 슬라이스를 뷰로 사용 |
| `SPARSE_BINDING_BIT` / `SPARSE_RESIDENCY_BIT` / `SPARSE_ALIASED_BIT` | 스파스 리소스 |
| `PROTECTED_BIT` | 보안 메모리 + 보안 큐 전용 |
| `EXTENDED_USAGE_BIT` | 뷰 포맷이 이미지 포맷과 다를 때 뷰 usage도 이미지 usage에 포함 |

---

## 5. 복사 명령 (Copy Commands)

복사 명령은 커맨드 버퍼 안에서 기록되며, **렌더 패스 외부**에서 실행해야 한다.

- `vkCmdCopyImage`/`vkCmdCopyBufferToImage`: `minImageTransferGranularity` 정렬을 만족해야 한다.
- `vkCmdUpdateBuffer`: 65536바이트 이하, 오프셋과 size 모두 4바이트 정렬.
- `vkCmdFillBuffer`: dstOffset과 size 모두 4바이트 정렬.

### 5.1. `vkCmdCopyBuffer` — 버퍼 간 복사

```c
void vkCmdCopyBuffer(
    VkCommandBuffer    commandBuffer,
    VkBuffer           srcBuffer,
    VkBuffer           dstBuffer,
    uint32_t           regionCount,
    const VkBufferCopy* pRegions);
```

> **스펙 발췌 (VUID-vkCmdCopyBuffer-pRegions-00117)** `pRegions`로 지정된 소스 영역들 사이, 그리고 목적지 영역들 사이는 **메모리상 겹치지 않아야 한다**. 단일 버퍼 내부에서의 자체 이동(In-place copy)은 금지되며 필요 시 스테이징 버퍼를 경유해야 한다.

### 5.2. `vkCmdCopyBufferToImage` — 텍스처 데이터 업로드

스테이징 버퍼의 픽셀 데이터를 GPU 최적화 이미지로 복사한다.

```c
VkBufferImageCopy region{};
region.bufferOffset      = 0;
region.bufferRowLength   = 0;  // 0이면 extent.width 기준으로 조밀하게 패킹됨
region.bufferImageHeight = 0;
region.imageSubresource  = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 };
region.imageOffset       = { 0, 0, 0 };
region.imageExtent       = { texWidth, texHeight, 1 };

vkCmdCopyBufferToImage(cmd, stagingBuffer, textureImage,
    VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &region);
```

- 복사 전 대상 이미지를 `TRANSFER_DST_OPTIMAL` 레이아웃으로 전환해야 한다.
- 복사 완료 후 셰이더에서 읽기 위해 `SHADER_READ_ONLY_OPTIMAL`로 다시 전환한다.

### 5.3. `vkCmdBlitImage` — 스케일링 및 포맷 변환

이미지 영역을 스케일링하거나 포맷을 재해석하면서 복사한다. 밉맵 생성에 주로 쓰인다.

- 큐는 **그래픽스 큐**에서만 지원된다.
- **MSAA 이미지는 blit 명령의 소스나 대상이 될 수 없다.** MSAA 다운샘플링에는 `vkCmdResolveImage`를 사용해야 한다.
- 소스와 대상의 텍셀 바이트 크기가 호환되는 포맷끼리만 복사할 수 있다.

```c
VkImageBlit blit{};
blit.srcSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, srcMip, 0, 1 };
blit.srcOffsets[0]  = { 0, 0, 0 };
blit.srcOffsets[1]  = { srcW, srcH, 1 };
blit.dstSubresource = { VK_IMAGE_ASPECT_COLOR_BIT, dstMip, 0, 1 };
blit.dstOffsets[0]  = { 0, 0, 0 };
blit.dstOffsets[1]  = { dstW > 1 ? dstW : 1, dstH > 1 ? dstH : 1, 1 };

vkCmdBlitImage(cmd,
    image, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
    image, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
    1, &blit, VK_FILTER_LINEAR);
```

### 5.4. `vkCmdResolveImage` — 멀티샘플(MSAA) 리졸브

MSAA 렌더 타깃의 샘플들을 단일 샘플(1x) 이미지로 다운샘플링한다. 소스는 MSAA(`samples > 1`), 대상은 1x(`samples == 1`)여야 한다. depth/stencil 이미지는 리졸브할 수 없다.

### 5.5. 밉맵 생성 패턴

가장 일반적인 텍스처 로딩 순서:

```c
// 1. 텍스처는 usage에 TRANSFER_DST | TRANSFER_SRC | SAMPLED, mipLevels = N
// 2. 초기 layout = UNDEFINED
// 3. 첫 barrier: UNDEFINED -> TRANSFER_DST_OPTIMAL
// 4. vkCmdCopyBufferToImage로 mip 0 업로드
// 5. for (i = 0; i+1 < N; ++i) {
//      barrier: mip i를 TRANSFER_DST -> TRANSFER_SRC
//      vkCmdBlitImage(src=mip i, dst=mip i+1, filter=LINEAR)
//    }
// 6. 마지막 mip까지 완료 후 전체 이미지를 SHADER_READ_ONLY_OPTIMAL로 전환
```

> [!NOTE]
> `vkCmdBlitImage`의 src/dst subresource는 **서로 다른 mip level**이어야 한다. 같은 이미지의 mip 간 blit이 일반적이다. `vkCmdCopyImage`로도 만들 수 있지만 스케일 없이 정확한 박스 복사만 가능하므로, 업로드 데이터를 mip별로 준비해야 한다.

---

## 6. 큐 패밀리 소유권 이전 (Queue Family Ownership Transfer)

`EXCLUSIVE` 공유 모드 리소스를 다른 큐 패밀리(예: 그래픽스 → 전송 전용 큐)로 넘기려면 소유권 이전 배리어가 필요하다.

1. **Release 배리어**: 소스 큐 패밀리의 커맨드 풀에서 할당된 커맨드 버퍼에 기록.
2. **Acquire 배리어**: 대상 큐 패밀리의 커맨드 풀에서 할당된 커맨드 버퍼에 기록.

```c
// 소스 큐(gfx)에서 Release 기록
VkImageMemoryBarrier releaseBar{};
releaseBar.sType               = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER;
releaseBar.srcAccessMask       = VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT;
releaseBar.dstAccessMask       = 0;
releaseBar.oldLayout           = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL;
releaseBar.newLayout           = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
releaseBar.srcQueueFamilyIndex = gfxQueueFamily;
releaseBar.dstQueueFamilyIndex = transferQueueFamily;
releaseBar.image               = image;
releaseBar.subresourceRange    = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };

vkCmdPipelineBarrier(gfxCmd,
    VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
    VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT,
    0, 0, nullptr, 0, nullptr, 1, &releaseBar);

// 대상 큐(xfer)에서 Acquire 기록
VkImageMemoryBarrier acquireBar = releaseBar;
acquireBar.srcAccessMask = 0;
acquireBar.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;

vkCmdPipelineBarrier(xferCmd,
    VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,
    VK_PIPELINE_STAGE_TRANSFER_BIT,
    0, 0, nullptr, 0, nullptr, 1, &acquireBar);
```

---

## 7. 자주 발생하는 오류 점검 목록

### 7.1. 리소스 생성 단계

- [ ] 버퍼 생성 시 `size == 0` 또는 `usage == 0` 지정 (VUID-size-00912 / VUID-None-09500).
- [ ] 이미지 생성 시 `mipLevels == 0` 또는 `arrayLayers == 0` (VUID-mipLevels-00947 / VUID-arrayLayers-00948).
- [ ] `tiling = LINEAR` 이미지에 압축 포맷(BC/ASTC 등)이나 밉맵을 적용하려 시도.
- [ ] `samples > 1`인 MSAA 이미지에 `SAMPLED` 또는 `STORAGE` 플래그를 직접 결합.
- [ ] `initialLayout`에 `UNDEFINED`나 `PREINITIALIZED` 외의 부적절한 레이아웃 지정.

### 7.2. 뷰 및 디스크립터 단계

- [ ] `subresourceRange.aspectMask`를 0으로 설정 (VUID-aspectMask-requiredbitmask).
- [ ] `CUBE` 뷰를 생성하면서 `layerCount`를 6으로 맞추지 않음 (VUID-viewType-02962).
- [ ] `MUTABLE_FORMAT_BIT` 없이 원본 이미지 포맷과 다른 포맷의 뷰 생성 시도.
- [ ] 깊이/스텐실 이미지에서 셰이더 샘플링용 뷰를 만들 때 두 애스펙트를 분리하지 않고 동시 지정.

### 7.3. 복사 및 블릿 단계

- [ ] `vkCmdCopy*` 복사 명령을 렌더 패스 내부에서 호출 (VUID-renderpass).
- [ ] 복사 명령의 소스 버퍼에 `TRANSFER_SRC`, 대상 버퍼에 `TRANSFER_DST` 플래그 누락.
- [ ] `vkCmdCopyBuffer` 호출 시 동일 버퍼 내에서 소스와 대상 범위가 겹침 (VUID-pRegions-00117).
- [ ] `vkCmdBlitImage`에 MSAA 이미지를 소스나 대상으로 전달 (대신 `vkCmdResolveImage` 사용).
- [ ] `vkCmdBlitImage`를 그래픽스 기능이 없는 전송 전용 큐에서 호출.

### 7.4. 레이아웃 및 동기화 단계

- [ ] `UNDEFINED` 상태로 생성된 이미지를 첫 사용 전 적절한 레이아웃으로 전환하지 않고 샘플링.
- [ ] 큐 소유권 이전 배리어 기록 시 Release는 소스 풀에서, Acquire는 대상 풀에서 기록하지 않음.
- [ ] 파이프라인 배리어에 해당 큐 패밀리가 지원하지 않는 파이프라인 스테이지 플래그 지정.

---

## 8. 빠른 참조 — 작업별 사용 API 및 큐 요구사항

| 작업 내용 | 사용 API | 필요 플래그 (src / dst) | 지원 큐 패밀리 |
|----------|----------|----------------------|---------------|
| 버퍼 간 데이터 복사 | `vkCmdCopyBuffer` | `TRANSFER_SRC` / `TRANSFER_DST` | 그래픽스 / 컴퓨트 / 전송 |
| 텍스처 데이터 업로드 | `vkCmdCopyBufferToImage` | `TRANSFER_SRC` / `TRANSFER_DST` | 그래픽스 / 컴퓨트 / 전송 |
| 텍스처 데이터 리드백 | `vkCmdCopyImageToBuffer` | `TRANSFER_SRC` / `TRANSFER_DST` | 그래픽스 / 컴퓨트 / 전송 |
| 이미지 간 직접 복사 | `vkCmdCopyImage` | `TRANSFER_SRC` / `TRANSFER_DST` | 그래픽스 / 컴퓨트 / 전송 |
| 스케일링/포맷 변환 (Blit) | `vkCmdBlitImage` | `TRANSFER_SRC` / `TRANSFER_DST` | **그래픽스 전용** |
| MSAA 리졸브 | `vkCmdResolveImage` | `TRANSFER_SRC` / `TRANSFER_DST` (dst: 1x) | **그래픽스 전용** |
| 버퍼 채우기 / 갱신 | `vkCmdFillBuffer` / `vkCmdUpdateBuffer` | — / `TRANSFER_DST` | 그래픽스 / 컴퓨트 / 전송 |
| 큐 소유권 이전 | `vkCmdPipelineBarrier` | Release / Acquire 배리어 | 양쪽 큐 모두 기록 |
