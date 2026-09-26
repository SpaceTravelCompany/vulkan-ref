---
title: 스파스 리소스 (Sparse Resources)
slug: sparse-resources
---

## 소개

**스파스 리소스(Sparse Resources)**는 물리 메모리보다 훨씬 큰 가상 리소스를 생성하고, 실제 사용되는 영역에만 물리 메모리를 선택적으로 바인딩한다. 파일 시스템의 스파스 파일처럼 전체 가상 주소 공간 중 **필요한 페이지만 물리 `VkDeviceMemory`에 매핑**하고 나머지는 미할당(unmapped) 상태로 유지할 수 있다.

### 스파스 리소스가 필요한 이유

기존 Vulkan 리소스는 전체 메모리가 생성 직후 단일 블록으로 완전히 할당 및 바인딩(fully resident)되어야 한다. 이 방식은 대규모 가상 자산을 다룰 때 다음과 같은 한계에 부딪힌다.

| 사용 시나리오 | 기존 방식의 한계 | 스파스 리소스의 해결책 |
|---|---|---|
| **16K × 16K 초고해상도 텍스처** (수 GB 이상) | VRAM 용량 부족으로 생성 불가 | 현재 화면에 표시되는 타일 페이지만 VRAM에 선별 적재 |
| **대용량 지형/스트리밍 메시** (거대 SSBO) | 초기 로딩 시 모든 정점을 적재해야 함 | 카메라 가시 영역에 위치한 블록만 점진적으로 스트리밍 |
| **가상 텍스처링 (Virtual Texturing / Mega Texture)** | 디스크의 방대한 텍스처 데이터를 VRAM에 올릴 수 없음 | 가시 영역의 Mip 레벨 블록만 필요할 때 바인딩 |
| **메모리 재활용 (Aliasing)** | 개별 리소스마다 전용 메모리 점유 | 서로 다른 시점에 쓰이는 영역끼리 동일 물리 메모리를 공유 |

```
[기존 방식]
VkImage (16GB 가상 크기) ──> vkAllocateMemory (16GB) ──> vkBindImageMemory (단일 1회 바인딩)
※ 16GB 물리 메모리가 즉시 필요하며 부족할 경우 생성 실패

[스파스 방식]
VkImage (16GB 가상 크기) ──> 가상 주소만 확보
VkDeviceMemory (1GB 풀)  ──> 필요한 타일 영역만 vkQueueBindSparse로 동적 매핑
※ 미매핑(unmapped) 타일은 셰이더가 접근하지 않도록 가드하여 VRAM 절약
```

스파스 리소스를 운용하려면 다음과 같은 규칙을 애플리케이션에서 직접 관리해야 한다.
- 셰이더가 미바인딩 영역을 함부로 읽지 않도록 설계하거나 드라이버 폴백 속성을 확인해야 한다.
- 메모리 바인딩이 일반 커맨드가 아니라 `vkQueueBindSparse` 큐 제출 명령으로 수행되므로 세마포어를 통한 동기화가 필수적이다.
- 타일 블록 정렬, 밉테일(Mip-tail) 처리, 에일리어싱 수명 주기를 직접 통제해야 한다.

> **주요 용어**
> - **스파스 바인딩 (Sparse Binding)**: 리소스 전체를 한 번에 바인딩하지 않고 블록(페이지) 단위로 바인딩 및 언바인딩하는 기본 기능.
> - **스파스 레지던시 (Sparse Residency)**: 리소스의 일부 블록에만 물리 메모리가 매핑된 상태(부분 레지던트)에서도 셰이더가 해당 리소스를 유효하게 참조할 수 있는 기능.
> - **스파스 에일리어싱 (Sparse Aliasing)**: 둘 이상의 스파스 리소스(또는 한 리소스의 서로 다른 영역)가 동일한 물리 메모리 블록을 시간차를 두고 공유하는 기법.
> - **블록 (Block / Page)**: 스파스 바인딩의 최소 단위. 버퍼는 통상 64KB 단위이며 이미지는 텍셀 단위의 하드웨어 타일 크기(`imageGranularity`)를 따른다.
> - **밉테일 (Mip-tail)**: 밉맵 체인에서 해상도가 작아져 스파스 블록 하나보다 작아진 저해상도 밉 레벨들의 묶음. 하나의 불투명(opaque) 메모리 영역으로 일괄 바인딩한다.
> - **`vkQueueBindSparse`**: 스파스 바인딩 명령을 큐에 제출하는 함수. `VK_QUEUE_SPARSE_BINDING_BIT`가 있는 큐에서 실행한다.

---

## 1. 일반 리소스와 스파스 리소스의 구조 비교

```flowchart
flowchart TD
  A["일반"]
  B["VkBuffer/Image"]
  C(["vkBind*Memory(device, ...) — 한 번에 fully bind"])
  D(["vkQueueSubmit(gfx/comp)"])
  E["Sparse"]
  F["VkBuffer/Image (flags: SPARSE_BINDING_BIT, ...)"]
  G(["vkGetBufferMemoryRequirements → alignment = sparse block size"])
  H["(필요시) vkGetImageSparseMemoryRequirements → mip-tail 정보"]
  I(["vkQueueBindSparse(queue, ...)"])
  J["bufferBinds: [...] — page-by-page 바인딩"]
  K["imageOpaqueBinds: [...] — mip-tail opaque 바인딩"]
  L["imageBinds: [...] — 일반 mip/page 바인딩"]
  M["signalSemaphores: [...] — 완료 신호"]
  N["그래픽/컴퓨트 큐가 sparse 큐의 시그널을 waitSemaphore로 받음"]
  A --> B --> C --> D
  E --> F --> G --> H --> I
  I --> J
  I --> K
  I --> L
  I --> M
  M --> N
```

| 구분 | 일반 리소스 | 스파스 리소스 |
|---|---|---|
| **바인딩 API** | `vkBindBufferMemory`, `vkBindImageMemory` (디바이스 수준 단발 호출) | `vkQueueBindSparse` (큐에 제출하는 비동기 연산) |
| **바인딩 단위** | 리소스 전체 단일 바인딩 | 블록, 타일 페이지, 밉테일 단위 분할 바인딩 |
| **메모리 점유** | 전체 가상 크기만큼 100% 물리 메모리 점유 | 실제 매핑된 페이지만 물리 메모리 점유 (부분 레지던트) |
| **실행 큐** | 그래픽스, 컴퓨트, 트랜스퍼 큐 | `VK_QUEUE_SPARSE_BINDING_BIT` 플래그를 갖춘 큐 |
| **동기화 방식** | 리소스 생성 단계에서 바인딩 완료 보장 | 세마포어/펜스를 통한 큐 간 명시적 동기화 필수 |

---

## 2. 스파스 리소스 생성과 플래그

### 2.1. 버퍼 생성 (`VkBufferCreateInfo`)

스파스 버퍼를 생성할 때는 `flags`에 용도에 맞는 비트를 지정한다.

```c
VkBufferCreateInfo bci{};
bci.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
bci.size  = 64 * 1024 * 1024; // 64MB 가상 주소 공간
bci.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
bci.flags = VK_BUFFER_CREATE_SPARSE_BINDING_BIT
          | VK_BUFFER_CREATE_SPARSE_RESIDENCY_BIT  // 부분 매핑 허용
          | VK_BUFFER_CREATE_SPARSE_ALIASED_BIT;  // 메모리 공유 허용 시 (선택)
```

| 플래그 | 설명 | 필요 디바이스 기능 |
|---|---|---|
| `VK_BUFFER_CREATE_SPARSE_BINDING_BIT` | 블록 단위 스파스 바인딩을 활성화한다. | `sparseBinding` |
| `VK_BUFFER_CREATE_SPARSE_RESIDENCY_BIT` | 일부 영역만 바인딩된 상태(부분 레지던트)에서의 사용을 허용한다. | `sparseResidencyBuffer` |
| `VK_BUFFER_CREATE_SPARSE_ALIASED_BIT` | 다른 리소스와 물리 메모리를 중복 바인딩할 수 있도록 허용한다. | `sparseResidencyAliased` |

> [!IMPORTANT]
> - `VK_BUFFER_CREATE_SPARSE_RESIDENCY_BIT`를 지정할 때는 반드시 `VK_BUFFER_CREATE_SPARSE_BINDING_BIT`를 함께 지정해야 한다.
> - 스파스 플래그가 지정된 버퍼는 `VK_BUFFER_CREATE_PROTECTED_BIT`와 함께 사용할 수 없다(VUID-VkBufferCreateInfo-None-01888).
> - NVIDIA 전용 할당(`VkDedicatedAllocationBufferCreateInfoNV::dedicatedAllocation = VK_TRUE`)과 스파스 비트는 동시에 사용할 수 없다(VUID-VkBufferCreateInfo-pNext-01571).

---

### 2.2. 이미지 생성 (`VkImageCreateInfo`)

스파스 이미지는 대용량 가상 텍스처를 구축할 때 핵심적으로 사용된다.

```c
VkImageCreateInfo ici{};
ici.sType         = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO;
ici.imageType     = VK_IMAGE_TYPE_2D;
ici.format        = VK_FORMAT_R8G8B8A8_UNORM;
ici.extent        = {16384, 16384, 1}; // 16K 초고해상도
ici.mipLevels     = 15;
ici.arrayLayers   = 1;
ici.samples       = VK_SAMPLE_COUNT_1_BIT;
ici.tiling        = VK_IMAGE_TILING_OPTIMAL;
ici.usage         = VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT;
ici.sharingMode   = VK_SHARING_MODE_EXCLUSIVE;
ici.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
ici.flags         = VK_IMAGE_CREATE_SPARSE_BINDING_BIT
                  | VK_IMAGE_CREATE_SPARSE_RESIDENCY_BIT
                  | VK_IMAGE_CREATE_SPARSE_ALIASED_BIT;
```

스파스 이미지는 지원하는 차원과 샘플 수에 따라 세분화된 디바이스 피처가 필요하다.

| 대상 피처 | 설명 |
|---|---|
| `sparseBinding` | 기본 스파스 바인딩 기능 |
| `sparseResidencyImage2D` | 2D 이미지의 부분 레지던시 지원 |
| `sparseResidencyImage3D` | 3D 볼륨 텍스처의 부분 레지던시 지원 |
| `sparseResidency2Samples` ~ `16Samples` | 멀티샘플 이미지의 스파스 레지던시 지원 |
| `sparseResidencyAliased` | 스파스 이미지의 메모리 에일리어싱 지원 |

---

## 3. 스파스 속성 및 요구사항 조회

### 3.1. 디바이스 스파스 속성 (`VkPhysicalDeviceSparseProperties`)

디바이스가 보장하는 하드웨어 제약 조건은 `VkPhysicalDeviceProperties::sparseProperties`에서 확인한다.

```c
VkPhysicalDeviceProperties props;
vkGetPhysicalDeviceProperties(physDev, &props);
const VkPhysicalDeviceSparseProperties& sp = props.sparseProperties;

// sp.residencyStandard2DBlockShape: 표준 2D 블록 형태 준수 여부
// sp.residencyStandard3DBlockShape: 표준 3D 블록 형태 준수 여부
// sp.residencyAlignedMipSize: 정렬된 밉 크기 보장 여부
// sp.residencyNonResidentStrict: 미바인딩 영역 접근 시 동작 보장 여부
```

`residencyNonResidentStrict`가 `VK_TRUE`이면 매핑되지 않은 영역에 대한 접근이 **정의된 동작**으로 보장된다. 읽기는 0으로 채워진 것처럼 반환되고, 쓰기는 폐기된다(스펙 36.7). `VK_FALSE`인 경우 접근 자체는 안전하지만 **읽기 값이 미정의**이므로, 애플리케이션은 페이지 테이블이나 클립맵 같은 가드를 통해 결과 정확성을 직접 확보해야 한다.

---

### 3.2. 이미지 스파스 메모리 요구사항 조회

스파스 이미지는 일반 메모리 요구사항(`vkGetImageMemoryRequirements`) 외에 타일 단위 형상과 밉테일 구조를 파악하기 위해 `vkGetImageSparseMemoryRequirements`를 호출해야 한다.

```c
uint32_t count = 0;
vkGetImageSparseMemoryRequirements(device, image, &count, nullptr);
std::vector<VkSparseImageMemoryRequirements> reqs(count);
vkGetImageSparseMemoryRequirements(device, image, &count, reqs.data());

for (const auto& req : reqs) {
    // req.formatProperties.aspectMask: 대상 에스펙트
    // req.formatProperties.imageGranularity: 텍셀 단위 타일 크기 (예: {64, 64, 1})
    // req.formatProperties.flags: SINGLE_MIPTAIL_BIT 등
    // req.imageMipTailFirstLod: 밉테일이 시작되는 밉 레벨 인덱스
    // req.imageMipTailSize: 밉테일 전체를 바인딩하는 데 필요한 바이트 크기
    // req.imageMipTailOffset: 밉테일의 가상 바인딩 시작 오프셋
    // req.imageMipTailStride: 배열 레이어 간 밉테일 오프셋 간격
}
```

> [!NOTE]
> 이미지가 `VK_IMAGE_CREATE_SPARSE_RESIDENCY_BIT` 없이 생성되었다면 `pSparseMemoryRequirements`는 반환되지 않는다.

---

### 3.3. 타일 크기 (`imageGranularity`)와 밉테일 (Mip-tail)

- **`imageGranularity`**: 타일 하나의 너비, 높이, 깊이(텍셀 단위)를 나타낸다. 이미지의 각 타일 바인딩 단위는 항상 이 크기의 배수로 정렬되어야 한다.
- **밉테일의 정의**: 밉 레벨이 점차 작아져 가로/세로 해상도가 단일 타일 블록(`imageGranularity`)보다 작아지면 개별 타일 단위로 분할하여 바인딩하는 것이 불가능해진다. 따라서 드라이버는 `imageMipTailFirstLod` 이상의 모든 저해상도 밉 레벨을 하나의 불투명(opaque) 메모리 블록으로 묶어 관리한다. 이를 **밉테일(Mip-tail)**이라 부르며 일반 타일 바인딩이 아닌 불투명 바인딩(`VkSparseImageOpaqueMemoryBindInfo`)으로 일괄 바인딩해야 한다.

```
Mip 0 (16K x 16K) ──> [ 타일 단위 분할 바인딩 가능 ]
Mip 1 ( 8K x  8K) ──> [ 타일 단위 분할 바인딩 가능 ]
...
Mip 10 (32 x 32)  ──┐
Mip 11 (16 x 16)  ──┼──> [ 밉테일 (Mip-tail) ]
Mip 12 ( 8 x  8)  ──┤    단일 블록 크기보다 작으므로
Mip 13 ( 4 x  4)  ──┘    불투명 바인딩으로 일괄 처리
```

---

## 4. 스파스 메모리 바인딩 기본 구조 (`VkSparseMemoryBind`)

스파스 버퍼와 불투명 이미지 바인딩에 공통으로 사용하는 바인딩 단위 구조체다.

```c
typedef struct VkSparseMemoryBind {
    VkDeviceSize             resourceOffset; // 리소스 내부 시작 오프셋 (블록 정렬)
    VkDeviceSize             size;           // 바인딩 크기 (0 초과, 블록 배수)
    VkDeviceMemory           memory;         // 바인딩할 메모리 (언바인딩 시 VK_NULL_HANDLE)
    VkDeviceSize             memoryOffset;   // 메모리 객체 내부 시작 오프셋
    VkSparseMemoryBindFlags  flags;          // 0 또는 VK_SPARSE_MEMORY_BIND_METADATA_BIT
} VkSparseMemoryBind;
```

**정렬 및 제약 규정:**
- 버퍼 바인딩 시 `resourceOffset`, `memoryOffset`, `size`는 반드시 `vkGetBufferMemoryRequirements`가 반환한 `alignment` 값(스파스 블록 크기)의 정수 배수여야 한다(VUID-VkSparseMemoryBind-resourceOffset-09491).
- 이미지 바인딩 시 `resourceOffset`, `memoryOffset`은 `vkGetImageMemoryRequirements`가 반환한 `alignment`의 정수 배수여야 한다(VUID-VkSparseMemoryBind-resourceOffset-09492).
- `memory`가 `VK_NULL_HANDLE`이 아닐 경우 해당 메모리는 `VK_MEMORY_PROPERTY_LAZILY_ALLOCATED_BIT` 속성을 가져서는 안 된다(VUID-VkSparseMemoryBind-memory-01097).
- `size > 0`, `resourceOffset + size <= resourceSize`, `memoryOffset + size <= memorySize`를 만족해야 한다(VUID-VkSparseMemoryBind-size-01098/01099/01100/01101/01102).
- 언바인딩(unmap)을 수행할 때는 `memory`에 `VK_NULL_HANDLE`을 넘기며 `size`는 해제할 블록 크기여야 한다.

---

## 5. 버퍼 스파스 바인딩 (`VkSparseBufferMemoryBindInfo`)

버퍼의 특정 블록들에 물리 메모리를 할당하여 바인딩하는 방법이다.

```c
// 1. 스파스 버퍼 생성
VkBufferCreateInfo bci{};
bci.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
bci.size  = 16 * 1024 * 1024; // 16MB 가상 크기
bci.usage = VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;
bci.flags = VK_BUFFER_CREATE_SPARSE_BINDING_BIT | VK_BUFFER_CREATE_SPARSE_RESIDENCY_BIT;
VkBuffer sparseBuf;
vkCreateBuffer(device, &bci, nullptr, &sparseBuf);

// 2. 블록 크기(정렬 요구치) 확인
VkMemoryRequirements memReq;
vkGetBufferMemoryRequirements(device, sparseBuf, &memReq);
const VkDeviceSize BLOCK_SIZE = memReq.alignment; // 통상 64KB

// 3. 4개 블록(256KB)을 수용할 물리 메모리 할당
VkMemoryAllocateInfo allocInfo{};
allocInfo.sType           = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
allocInfo.allocationSize  = 4 * BLOCK_SIZE;
allocInfo.memoryTypeIndex = findMemoryType(memProps, memReq.memoryTypeBits,
                                          VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
VkDeviceMemory physicalMem;
vkAllocateMemory(device, &allocInfo, nullptr, &physicalMem);

// 4. 버퍼 오프셋 0~3 페이지를 물리 메모리에 매핑
VkSparseMemoryBind binds[4];
for (uint32_t i = 0; i < 4; ++i) {
    binds[i].resourceOffset = i * BLOCK_SIZE;
    binds[i].size           = BLOCK_SIZE;
    binds[i].memory         = physicalMem;
    binds[i].memoryOffset   = i * BLOCK_SIZE;
    binds[i].flags          = 0;
}

VkSparseBufferMemoryBindInfo bufferBindInfo{};
bufferBindInfo.buffer    = sparseBuf;
bufferBindInfo.bindCount = 4;
bufferBindInfo.pBinds    = binds;
```

---

## 6. 이미지 스파스 바인딩

스파스 이미지는 밉테일/메타데이터를 바인딩하는 **불투명 바인딩**과 일반 밉 레벨의 사각 타일을 바인딩하는 **이미지 타일 바인딩**의 두 경로로 나뉜다.

### 6.1. 밉테일 불투명 바인딩 (`VkSparseImageOpaqueMemoryBindInfo`)

밉테일 영역은 반드시 불투명 바인딩 구조체를 통해 매핑해야 한다.

```c
typedef struct VkSparseImageOpaqueMemoryBindInfo {
    VkImage                     image;
    uint32_t                    bindCount;
    const VkSparseMemoryBind*   pBinds;
} VkSparseImageOpaqueMemoryBindInfo;
```

`formatProperties.flags`에 `VK_SPARSE_IMAGE_FORMAT_SINGLE_MIPTAIL_BIT`가 포함되어 있다면 모든 배열 레이어가 하나의 밉테일을 공유하므로 단일 `VkSparseMemoryBind`로 처리할 수 있다. 플래그가 없다면 배열 레이어마다 `imageMipTailStride` 오프셋을 더해 개별적으로 바인딩해야 한다.

```c
VkSparseMemoryBind mipTailBind{};
mipTailBind.resourceOffset = req.imageMipTailOffset;
mipTailBind.size           = req.imageMipTailSize;
mipTailBind.memory         = mipTailMemory;
mipTailBind.memoryOffset   = 0;
mipTailBind.flags          = 0;

VkSparseImageOpaqueMemoryBindInfo opaqueBind{};
opaqueBind.image     = sparseImage;
opaqueBind.bindCount = 1;
opaqueBind.pBinds    = &mipTailBind;
```

---

### 6.2. 타일 단위 바인딩 (`VkSparseImageMemoryBindInfo`)

밉테일보다 해상도가 큰 일반 밉 레벨은 텍셀 좌표 영역(`VkOffset3D`, `VkExtent3D`)을 지정하여 타일 단위로 바인딩한다.

```c
typedef struct VkSparseImageMemoryBind {
    VkImageSubresource       subresource;  // aspect, mipLevel, arrayLayer
    VkOffset3D               offset;       // 텍셀 시작 좌표 (imageGranularity 배수)
    VkExtent3D               extent;       // 텍셀 범위 (imageGranularity 배수)
    VkDeviceMemory           memory;       // 물리 메모리 객체 (언매핑 시 VK_NULL_HANDLE)
    VkDeviceSize             memoryOffset; // 메모리 내부 오프셋
    VkSparseMemoryBindFlags  flags;        // 0
} VkSparseImageMemoryBind;

typedef struct VkSparseImageMemoryBindInfo {
    VkImage                          image;
    uint32_t                         bindCount;
    const VkSparseImageMemoryBind*   pBinds;
} VkSparseImageMemoryBindInfo;
```

> [!NOTE]
> 이미지의 우측 및 하단 모서리 영역은 타일 크기로 나누어떨어지지 않아 부분 사용 블록(Partially used block)이 될 수 있다. 이 경우에도 물리 메모리는 온전한 전체 블록 바이트 크기만큼 할당되어야 한다.

---

### 6.3. 메타데이터 바인딩

하드웨어 압축 메타데이터(`VK_IMAGE_ASPECT_METADATA_BIT`)는 별도 에스펙트로 취급된다. 메타데이터를 명시적으로 바인딩할 때는 불투명 바인딩 구조체를 사용하며, `flags`에 반드시 `VK_SPARSE_MEMORY_BIND_METADATA_BIT`를 지정해야 한다.

---

## 7. 스파스 바인딩 명령 제출 (`vkQueueBindSparse`)

스파스 바인딩 작업은 커맨드 버퍼에 기록되지 않고 `vkQueueBindSparse`를 통해 큐에 직접 제출된다.

```c
VkResult vkQueueBindSparse(
    VkQueue                 queue,          // VK_QUEUE_SPARSE_BINDING_BIT 지원 큐
    uint32_t                bindInfoCount,
    const VkBindSparseInfo* pBindInfo,
    VkFence                 fence);
```

### 7.1. 큐 요구사항과 동기화 규칙

- `vkQueueBindSparse`는 디바이스 생성 시 `VK_QUEUE_SPARSE_BINDING_BIT`가 켜진 큐 패밀리에서만 호출할 수 있다.
- 스파스 바인딩 연산은 동일 큐 내에서 실행 중인 일반 커맨드 버퍼 작업과도 **자동으로 실행 순서가 정렬되지 않는다**.
- 따라서 바인딩 작업이 완료된 후 그래픽스/컴퓨트 셰이더에서 리소스를 안전하게 사용하려면 반드시 **세마포어(Semaphore)**를 통해 실행 의존성을 연결해야 한다.

```c
VkBindSparseInfo bindInfo{};
bindInfo.sType                = VK_STRUCTURE_TYPE_BIND_SPARSE_INFO;
bindInfo.waitSemaphoreCount   = 1;
bindInfo.pWaitSemaphores      = &priorWorkFinishedSemaphore; // 선행 작업 완료 대기
bindInfo.bufferBindCount      = 1;
bindInfo.pBufferBinds         = &bufferBindInfo;
bindInfo.signalSemaphoreCount = 1;
bindInfo.pSignalSemaphores    = &sparseBindCompleteSemaphore;// 바인딩 완료 후 시그널

vkQueueBindSparse(sparseQueue, 1, &bindInfo, VK_NULL_HANDLE);
```

---

### 7.2. 타임라인 세마포어 연계 (Vulkan 1.2+)

타임라인 세마포어를 사용하면 단조 증가 카운터를 통해 스파스 스트리밍을 정밀하게 제어할 수 있다.

```c
VkTimelineSemaphoreSubmitInfo timelineInfo{};
timelineInfo.sType                     = VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO;
timelineInfo.waitSemaphoreValueCount   = 1;
timelineInfo.pWaitSemaphoreValues      = &waitValue;
timelineInfo.signalSemaphoreValueCount = 1;
timelineInfo.pSignalSemaphoreValues    = &signalValue;

VkBindSparseInfo bindInfo{};
bindInfo.sType                = VK_STRUCTURE_TYPE_BIND_SPARSE_INFO;
bindInfo.pNext                = &timelineInfo; // pNext 체이닝 필수 (VUID-VkBindSparseInfo-pNext-03246/03247/03248)
bindInfo.waitSemaphoreCount   = 1;
bindInfo.pWaitSemaphores      = &timelineSemaphore;
bindInfo.signalSemaphoreCount = 1;
bindInfo.pSignalSemaphores    = &timelineSemaphore;
bindInfo.bufferBindCount      = 1;
bindInfo.pBufferBinds         = &bufferBindInfo;

vkQueueBindSparse(sparseQueue, 1, &bindInfo, VK_NULL_HANDLE);
```

---

## 8. 미바인딩(Unmapped) 영역 접근 가드

스파스 레지던트 리소스에서 물리 메모리가 바인딩되지 않은 영역에 셰이더가 접근할 때의 동작은 디바이스 속성에 좌우된다.

- **`residencyNonResidentStrict == VK_TRUE`**:
  미바인딩 영역 접근이 **정의된 동작**으로 보장된다. 읽기는 0으로 채워진 것처럼 반환되고, 쓰기는 폐기된다. 하드웨어가 안전성을 보장하므로 별도의 셰이더 가드 없이도 예측 가능한 결과를 얻는다.
- **`residencyNonResidentStrict == VK_FALSE`**:
  접근 자체는 안전하지만 **읽기 값이 미정의**다. 0을 가정하면 안 되며, 페이지 테이블이나 클립맵 같은 애플리케이션 레벨 가드가 결과 정확성을 위해 필요하다.

**실무 가드 전략:**
1. **셰이더 클립핑 및 디스카드**: 클립맵이나 타일 렌더러에서 미적재 영역의 텍셀 샘플링 시 `discard` 처리한다.
2. **밉맵 클램핑**: 고해상도 밉이 아직 로드되지 않은 상태라면 텍스처 샘플러의 `minLod` 또는 셰이더의 텍스처 조회 함수에서 바인딩 완료된 저해상도 밉으로 강제 클램프한다.
3. **가시성 페이지 테이블**: CPU가 타일 매핑 상태를 비트셋이나 소형 버퍼로 관리하여 유니폼 버퍼로 셰이더에 전달한다.

---

## 9. 스파스 에일리어싱 (Sparse Aliasing)

동일한 물리 메모리 영역에 둘 이상의 스파스 리소스 또는 동일 리소스의 서로 다른 블록을 중복 바인딩하여 메모리를 절약하는 기법이다.

- 리소스 생성 시 반드시 `SPARSE_ALIASED_BIT`를 지정해야 하며, 물리 디바이스의 `sparseResidencyAliased` 피처가 활성화되어 있어야 한다.
- 동일한 메모리 블록을 여러 리소스가 동시에 읽고 쓰면 데이터 레이스가 발생하므로, 특정 시점에는 활성화된 하나의 리소스만 접근해야 한다. 리소스 전환 시 큐 배리어와 세마포어로 수명 주기를 제어해야 한다.

---

## 10. 동적 페이지 스트리밍 패턴

가상 텍스처 렌더러는 카메라 이동에 따라 시야에서 벗어난 타일을 언바인딩하고 새로 시야에 들어온 타일을 바인딩한다.

```c
// 1. 기존 타일 언바인딩 (memory에 VK_NULL_HANDLE 지정)
VkSparseMemoryBind unbindBlock{};
unbindBlock.resourceOffset = oldPageOffset;
unbindBlock.size           = BLOCK_SIZE;
unbindBlock.memory         = VK_NULL_HANDLE; // 언바인딩
unbindBlock.memoryOffset   = 0;

VkSparseBufferMemoryBindInfo unbindInfo{ sparseBuf, 1, &unbindBlock };

// 2. 신규 타일 바인딩
VkSparseMemoryBind bindBlock{};
bindBlock.resourceOffset = newPageOffset;
bindBlock.size           = BLOCK_SIZE;
bindBlock.memory         = poolMemory;
bindBlock.memoryOffset   = targetPoolOffset;

VkSparseBufferMemoryBindInfo bindInfo{ sparseBuf, 1, &bindBlock };

// 3. 단일 배치로 언바인딩과 바인딩 동시 제출
VkSparseBufferMemoryBindInfo batchInfos[2] = { unbindInfo, bindInfo };
VkBindSparseInfo submitInfo{};
submitInfo.sType           = VK_STRUCTURE_TYPE_BIND_SPARSE_INFO;
submitInfo.bufferBindCount = 2;
submitInfo.pBufferBinds    = batchInfos;
submitInfo.signalSemaphoreCount = 1;
submitInfo.pSignalSemaphores    = &streamingDoneSemaphore;

vkQueueBindSparse(sparseQueue, 1, &submitInfo, VK_NULL_HANDLE);
```

> [!TIP]
> 해제와 바인딩 작업을 개별적인 `vkQueueBindSparse` 호출로 쪼개지 않고 단일 `VkBindSparseInfo` 배치에 모아서 제출하면 큐 제출 오버헤드와 동기화 비용을 대폭 줄일 수 있다.

---

## 11. 주요 점검 사항

### 11.1. 리소스 생성 단계
- [ ] `SPARSE_RESIDENCY_BIT` 사용 시 `SPARSE_BINDING_BIT`가 함께 설정되었는지 확인
- [ ] 스파스 플래그와 `VK_BUFFER_CREATE_PROTECTED_BIT`가 함께 지정되지 않았는지 확인
- [ ] 디바이스 생성 시 `sparseBinding`, `sparseResidencyBuffer`, `sparseResidencyImage2D` 등 필요한 피처가 활성화되었는지 확인

### 11.2. 바인딩 및 정렬 단계
- [ ] 버퍼의 `resourceOffset`, `memoryOffset`, `size`가 `VkMemoryRequirements::alignment`의 배수인지 확인
- [ ] 이미지 타일 바인딩의 오프셋과 크기가 `imageGranularity`의 정수 배수인지 확인
- [ ] 밉테일 영역을 일반 타일 바인딩이 아닌 불투명 바인딩(`VkSparseImageOpaqueMemoryBindInfo`)으로 처리했는지 확인
- [ ] 메타데이터 바인딩 시 `VK_SPARSE_MEMORY_BIND_METADATA_BIT` 플래그 지정 확인
- [ ] 언바인딩 시 `memory`가 `VK_NULL_HANDLE`이어도 `size`는 유효한 블록 크기 배수인지 확인

### 11.3. 큐 제출 및 동기화 단계
- [ ] `vkQueueBindSparse`를 호출하는 큐 패밀리가 `VK_QUEUE_SPARSE_BINDING_BIT`를 지원하는지 확인
- [ ] 스파스 바인딩 작업 완료를 알리는 세마포어가 그래픽스/컴퓨트 큐의 제출 커맨드와 올바르게 연결되었는지 확인
- [ ] `residencyNonResidentStrict`가 활성화된 디바이스에서 미바인딩 영역에 접근하지 않도록 셰이더 가드가 갖추어졌는지 확인

---

## 12. 빠른 참조 요약

| 구현 목적 | 권장 기법 |
|---|---|
| 수십 GB 단위 초고해상도 텍스처 | 스파스 이미지 레지던시 + 밉테일 불투명 바인딩 |
| 대규모 스트리밍 정점/지형 데이터 | 스파스 버퍼 레지던시 |
| 동적 타일 캐시 풀 재활용 | 스파스 에일리어싱 (`SPARSE_ALIASED_BIT`) |
| 밉테일 바인딩 방식 판별 | `SINGLE_MIPTAIL_BIT` 확인 (단일 바인딩 vs 레이어별 스트라이드) |
| 스파스 블록 정렬 기준 | `VkMemoryRequirements::alignment` 값 준수 |
