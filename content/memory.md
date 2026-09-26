---
title: 메모리
slug: memory
---

## 소개

Vulkan에서 **메모리 관리**는 전적으로 애플리케이션이 담당한다. 드라이버가 메모리를 자동으로 관리해주지 않으므로 메모리 타입 선택, 정렬, 캐시 정책까지 직접 결정해야 한다. 제어권이 개발자에게 있는 만큼 높은 수준의 최적화가 가능하다.

> **주요 용어**
> - **VRAM**: GPU 전용 메모리. 접근 속도가 가장 빠르다.
> - **스테이징 버퍼(Staging Buffer)**: CPU와 GPU 사이에 데이터를 전송하기 위한 호스트 가시적 중계 버퍼.
> - **메모리 타입(Memory Type)**: 메모리의 접근 속성(캐시 정책, 가시성 등).
> - **메모리 힙(Memory Heap)**: 물리 메모리 풀(VRAM 또는 시스템 RAM).

---

## 1. 메모리 요구사항 (`VkMemoryRequirements`)

버퍼나 이미지를 생성한 뒤 `vkGetBufferMemoryRequirements` 또는 `vkGetImageMemoryRequirements`를 호출하여 리소스에 필요한 메모리 제약 조건을 확인한다.

```c
typedef struct VkMemoryRequirements {
    VkDeviceSize    size;          // 필요한 메모리 크기 (바이트 단위)
    VkDeviceSize    alignment;     // 오프셋 정렬 요구치 (2의 거듭제곱)
    uint32_t        memoryTypeBits;// 할당 가능한 메모리 타입 비트마스크
} VkMemoryRequirements;
```

- `size`: 리소스에 할당해야 하는 최소 메모리 크기다.
- `alignment`: `vkBindBufferMemory` 또는 `vkBindImageMemory`에 전달하는 `memoryOffset`의 정렬 단위다. **항상 2의 거듭제곱**이다.
- `memoryTypeBits`: 리소스를 지원하는 메모리 타입의 비트마스크다. $i$번째 비트가 1이면 메모리 타입 $i$에 바인딩할 수 있다.

```c
VkMemoryRequirements memReqs;
vkGetBufferMemoryRequirements(device, buffer, &memReqs);
// memReqs.alignment: 통상 64 또는 256 바이트
// memReqs.memoryTypeBits: 할당 가능한 메모리 타입 후보군
```

---

### 1.1. 버퍼 정렬과 사용 목적

버퍼의 정렬 요구치는 `usage` 플래그에 따라 추가적인 제약이 붙는다.

| 사용 플래그 | 추가 정렬 제약 |
|---|---|
| `VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT` | `limits.minUniformBufferOffsetAlignment`의 배수 (통상 256) |
| `VK_BUFFER_USAGE_STORAGE_BUFFER_BIT` | `limits.minStorageBufferOffsetAlignment`의 배수 (통상 256) |
| `VK_BUFFER_USAGE_UNIFORM_TEXEL_BUFFER_BIT` / `STORAGE_TEXEL_BUFFER_BIT` | `limits.minTexelBufferOffsetAlignment`의 배수 |

```c
VkPhysicalDeviceProperties props;
vkGetPhysicalDeviceProperties(physDev, &props);
// props.limits.minUniformBufferOffsetAlignment는 통상 256
```

---

### 1.2. 이미지 정렬 특성

이미지 정렬은 타일링 방식에 따라 결정된다.

- **Linear tiling**: 행(Row) 단위로 정렬된다. CPU가 직접 접근할 수 있으나 GPU 처리 성능이 떨어진다.
- **Optimal tiling**: GPU 하드웨어에 맞춰 2D/3D 블록 형태로 타일링된다. GPU 전용 메모리에서 최고 성능을 낸다.

`VK_KHR_maintenance4`(Vulkan 1.3 코어) 기능이 켜져 있다면, 동일한 핵심 생성 파라미터를 갖는 이미지들은 `VkMemoryRequirements::alignment`가 항상 동일하다고 보장된다.

비교 대상 매개변수:
- `flags`, `imageType`, `format`, `extent`, `mipLevels`, `arrayLayers`, `samples`, `tiling`, `usage`

따라서 메모리 할당자는 동일 속성의 이미지에 대해 매번 정렬 요구치를 쿼리하지 않고 정렬 값을 캐싱하여 재사용할 수 있다. 단, `size`와 `memoryTypeBits`는 보장 대상이 아니므로 정렬 값만 캐싱해야 한다.

---

## 2. 메모리 타입과 힙 (`VkPhysicalDeviceMemoryProperties`)

물리 디바이스가 제공하는 메모리 아키텍처는 `vkGetPhysicalDeviceMemoryProperties`로 조회한다.

```c
typedef struct VkPhysicalDeviceMemoryProperties {
    uint32_t        memoryTypeCount;
    VkMemoryType    memoryTypes[VK_MAX_MEMORY_TYPES];   // 최대 32개
    uint32_t        memoryHeapCount;
    VkMemoryHeap    memoryHeaps[VK_MAX_MEMORY_HEAPS];   // 최대 16개
} VkPhysicalDeviceMemoryProperties;
```

**힙(Heap)**은 물리 메모리 풀(VRAM 풀, 시스템 RAM 풀)을 나타내며, **메모리 타입(Memory Type)**은 해당 힙 내에서 지원하는 접근 속성(캐싱, 가시성 등)의 조합이다.

```c
typedef struct VkMemoryHeap {
    VkDeviceSize         size;
    VkMemoryHeapFlags    flags;              // DEVICE_LOCAL_BIT 여부
} VkMemoryHeap;

typedef struct VkMemoryType {
    VkMemoryPropertyFlags    propertyFlags;  // 속성 플래그 조합
    uint32_t                 heapIndex;      // 소속 힙 인덱스
} VkMemoryType;
```

---

### 2.1. 메모리 속성 플래그 (`VkMemoryPropertyFlagBits`)

각 메모리 타입은 `propertyFlags` 비트마스크로 고유한 동작 특성을 정의한다.

| 플래그 | 설명 |
|---|---|
| `DEVICE_LOCAL` | GPU 전용 고속 메모리(VRAM). VRAM 힙에 속한 타입에 설정된다. |
| `HOST_VISIBLE` | CPU가 `vkMapMemory`를 호출하여 호스트 가상 주소 공간에 매핑할 수 있다. |
| `HOST_COHERENT` | CPU와 GPU 사이의 메모리 가시성을 드라이버가 자동으로 보장한다. Flush 및 Invalidate 작업이 불필요하다. |
| `HOST_CACHED` | CPU 캐시를 경유한다. CPU 읽기 속도가 크게 향상된다. |
| `LAZILY_ALLOCATED` | 실제 렌더링에 사용될 때만 물리 메모리를 할당한다. `VK_IMAGE_USAGE_TRANSIENT_ATTACHMENT_BIT`를 가진 임시 렌더 타깃 전용이며, **일반 버퍼나 텍스처에는 사용할 수 없다**. |
| `PROTECTED` | 하드웨어 수준의 보호 메모리다. 보안 큐(Protected Queue)를 통해서만 접근할 수 있으며, CPU(`vkMapMemory`) 접근은 전면 차단된다. |
| `DEVICE_COHERENT_AMD` | GPU 캐시 계층 간 자동 일관성을 지원한다. |
| `DEVICE_UNCACHED_AMD` | GPU 캐시를 거치지 않는다. 느리지만 **항상 device coherent**가 보장된다. |
| `RDMA_CAPABLE_BIT_NV` | NVIDIA RDMA(GPUDirect) 대응 메모리다. |

---

### 2.2. 보안 큐와 보호된 메모리

`VK_MEMORY_PROPERTY_PROTECTED_BIT`가 지정된 메모리는 일반적인 방법으로 접근할 수 없는 보안 영역이다.

- **보안 큐 전용**: 디바이스 생성 시 `VK_DEVICE_QUEUE_CREATE_PROTECTED_BIT`로 생성한 보안 큐를 통해서만 읽고 쓸 수 있다.
- **호스트 접근 차단**: CPU가 `vkMapMemory`로 매핑을 시도하면 즉시 오류가 발생한다.
- **주요 용도**: DRM 보호 콘텐츠(4K 영상 등)의 하드웨어 디코딩 데이터를 메모리 덤프로부터 격리 보호할 때 사용한다.
---

> [!NOTE]
> AMD 확장: `DEVICE_COHERENT_AMD`와 `DEVICE_UNCACHED_AMD`가 동시에 설정된 메모리는 일반 접근보다 현저히 느릴 수 있다. 필수적인 경우가 아니면 이 조합을 피한다.

### 2.3. 자주 나타나는 메모리 타입 구성

스펙은 다음을 보장한다.
- `HOST_VISIBLE | HOST_COHERENT` 메모리 타입이 **최소 1개 이상 존재**한다.
- `DEVICE_LOCAL` 속성을 가진 메모리 타입이 **최소 1개 이상 존재**한다.
- `HOST_CACHED` 조합은 디바이스에 따라 제공되지 않을 수도 있다.

```
# 외장 GPU (NVIDIA / AMD dGPU)
Type 0: DEVICE_LOCAL                                    → VRAM (버텍스, 텍스처, 렌더 타깃)
Type 1: HOST_VISIBLE | HOST_COHERENT                    → 업로드용 스테이징 버퍼 (Uncached)
Type 2: HOST_VISIBLE | HOST_CACHED | HOST_COHERENT      → 리드백 버퍼 (CPU 읽기 최적화)
Type 3: DEVICE_LOCAL | HOST_VISIBLE | HOST_COHERENT     → ReBAR / Smart Access Memory 지원 시

# 통합 GPU (Intel iGPU / Apple Silicon / AMD APU)
Type 0: DEVICE_LOCAL | HOST_VISIBLE | HOST_COHERENT     → UMA 구조 (CPU와 GPU 메모리 공유)
Type 1: HOST_VISIBLE | HOST_COHERENT                    → 스테이징 호환
Type 2: HOST_VISIBLE | HOST_CACHED | HOST_COHERENT      → 리드백
```

---

## 3. 캐시 정책과 일관성 (Coherence & Caching)

스펙 11.2는 **"uncached memory is always host coherent"** 라고 명시한다. 즉 `HOST_VISIBLE`만 있고 `HOST_COHERENT`가 없는 메모리 타입은 존재하지 않으며, non-coherent 타입은 반드시 `HOST_CACHED`를 함께 갖는다.

| 플래그 조합 | CPU 읽기 | CPU 쓰기 | 동기화 요구사항 | 권장 용도 |
|---|---|---|---|---|
| **Uncached + Coherent**<br>(`VISIBLE \| COHERENT`) | 느림 (DRAM 직접 접근) | 빠름 (Write-Combining) | Flush / Invalidate 불필요 | CPU → GPU 데이터 전송 (스테이징 버퍼) |
| **Cached + Coherent**<br>(`VISIBLE \| CACHED \| COHERENT`) | 매우 빠름 (L1/L2 캐시) | 빠름 (캐시 기록) | Flush / Invalidate 불필요 | GPU → CPU 리드백 (쿼리, 스크린샷) |
| **Cached + Non-coherent**<br>(`VISIBLE \| CACHED`) | 매우 빠름 (L1/L2 캐시) | 빠름 (캐시 기록) | **Flush / Invalidate 필수** | 일관성을 수동 관리하는 대용량 리드백 |

> [!NOTE]
> 스펙은 `HOST_VISIBLE | HOST_COHERENT` 조합이 최소 하나 존재해야 한다고 규정한다. uncached 메모리는 항상 coherent이므로, non-coherent 메모리를 사용할 때는 반드시 `HOST_CACHED`가 함께 설정된다.

---

### 3.1. 수동 동기화: Flush와 Invalidate

`HOST_COHERENT` 플래그가 없는 메모리를 다룰 때는 호스트와 디바이스의 메모리 뷰를 일치시키기 위해 명시적 API를 호출해야 한다.

```c
// 1. CPU 쓰기 후 GPU가 읽기 전: Flush 호출
void* data;
vkMapMemory(device, memory, 0, VK_WHOLE_SIZE, 0, &data);
memcpy(data, src, size);

VkMappedMemoryRange range{};
range.sType  = VK_STRUCTURE_TYPE_MAPPED_MEMORY_RANGE;
range.memory = memory;
range.offset = 0;
range.size   = VK_WHOLE_SIZE;
vkFlushMappedMemoryRanges(device, 1, &range);    // CPU 캐시 라인을 GPU 가시 메모리로 밀어냄

// 2. GPU 쓰기 후 CPU가 읽기 전: Invalidate 호출
vkWaitForFences(device, 1, &fence, VK_TRUE, UINT64_MAX); // GPU 연산 완료 대기
vkInvalidateMappedMemoryRanges(device, 1, &range);        // CPU 캐시를 무효화하여 최신 데이터 로드
// 이제 data 포인터에서 CPU 읽기 수행
```

`HOST_COHERENT`가 설정된 메모리 타입에서는 위 두 호출을 생략할 수 있다.

#### nonCoherentAtomSize 정렬 규칙

Non-coherent 메모리에서 `VkMappedMemoryRange`의 `offset`과 `size`는 `VkPhysicalDeviceLimits::nonCoherentAtomSize`의 배수여야 한다(VUID-VkMappedMemoryRange-offset-00687, VUID-VkMappedMemoryRange-size-01389, VUID-VkMappedMemoryRange-size-01390). 단, `size`가 할당末尾까지 도달하는 경우(`offset + size == allocationSize`)에는 정렬 예외가 적용된다.

```c
// nonCoherentAtomSize가 64인 경우
VkMappedMemoryRange range{};
range.sType  = VK_STRUCTURE_TYPE_MAPPED_MEMORY_RANGE;
range.memory = memory;
range.offset = 0;           // 64의 배수
range.size   = 256;         // 64의 배수 (또는 VK_WHOLE_SIZE)
vkFlushMappedMemoryRanges(device, 1, &range);
```

---

### 3.2. `HOST_CACHED`의 필요성

Uncached 메모리는 CPU 쓰기에 Write-Combining 버퍼를 써서 쓰기 속도는 괜찮지만, 읽기는 캐시를 거치지 않고 DRAM에 직접 접근하므로 매우 느리다.

CPU가 GPU의 실행 결과를 주기적으로 읽어야 하는 상황에서는 `HOST_CACHED` 메모리가 필수적이다.

- **GPU 쿼리 결과 조회**: 오클루전, 타임스탬프, 파이프라인 통계 등을 CPU에서 폴링할 때
- **스크린샷 및 프레임 리드백**: 화면 픽셀 전체를 CPU 메모리로 복사할 때
- **컴퓨트 시뮬레이션 결과 수집**: 물리 연산이나 파티클 상태를 CPU 로직에서 반영할 때
- **간접 드로 커맨드 카운트 확인**: GPU에서 걸러진 가시 인스턴스 수를 CPU에서 확인할 때

> [!TIP]
> 데스크톱 dGPU 환경에서는 통상 `HOST_VISIBLE | HOST_CACHED | HOST_COHERENT` 타입이 함께 제공되지만, 모바일 타일 기반 GPU나 일부 내장 그래픽에서는 해당 조합이 없을 수 있다. 메모리 탐색 함수에서 우선순위를 두어 검색하고, 없으면 non-coherent 조합으로 폴백한 뒤 수동 Invalidate를 처리해야 한다.

---

## 4. 스테이징 버퍼 패턴

GPU 전용 고속 메모리(`DEVICE_LOCAL`)는 일반적으로 CPU가 직접 접근할 수 없다. 따라서 호스트 가시 메모리에 스테이징 버퍼를 생성하여 데이터를 적재한 뒤, GPU 커맨드로 최종 리소스에 복사한다. 단, ReBAR/Smart Access Memory가 활성화된 시스템에서는 `DEVICE_LOCAL | HOST_VISIBLE` 타입이 존재하여 CPU가 VRAM에 바로 쓸 수 있다(아래 §4.1 참고).

```
[CPU 가상 메모리]
      │ memcpy
      ▼
[스테이징 버퍼] (HOST_VISIBLE | HOST_COHERENT, Uncached)
      │ vkCmdCopyBuffer / vkCmdCopyBufferToImage
      ▼
[디바이스 버퍼 / 이미지] (DEVICE_LOCAL, VRAM)
```

```c
// 1. 디바이스 로컬 버퍼 생성 (최종 목적지)
VkBufferCreateInfo dstCI{};
dstCI.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
dstCI.size  = dataSize;
dstCI.usage = VK_BUFFER_USAGE_VERTEX_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
vkCreateBuffer(device, &dstCI, nullptr, &gpuBuffer);

VkMemoryRequirements dstReqs;
vkGetBufferMemoryRequirements(device, gpuBuffer, &dstReqs);

VkMemoryAllocateInfo dstAlloc{};
dstAlloc.sType           = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
dstAlloc.allocationSize  = dstReqs.size;
dstAlloc.memoryTypeIndex = findMemoryType(memProps, dstReqs.memoryTypeBits,
                                          VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
VkDeviceMemory gpuMemory;
vkAllocateMemory(device, &dstAlloc, nullptr, &gpuMemory);
vkBindBufferMemory(device, gpuBuffer, gpuMemory, 0);

// 2. 스테이징 버퍼 생성
VkBufferCreateInfo srcCI{};
srcCI.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
srcCI.size  = dataSize;
srcCI.usage = VK_BUFFER_USAGE_TRANSFER_SRC_BIT;
vkCreateBuffer(device, &srcCI, nullptr, &stagingBuffer);

VkMemoryRequirements srcReqs;
vkGetBufferMemoryRequirements(device, stagingBuffer, &srcReqs);

VkMemoryAllocateInfo srcAlloc{};
srcAlloc.sType           = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
srcAlloc.allocationSize  = srcReqs.size;
srcAlloc.memoryTypeIndex = findMemoryType(memProps, srcReqs.memoryTypeBits,
                                          VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
                                          VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
VkDeviceMemory stagingMemory;
vkAllocateMemory(device, &srcAlloc, nullptr, &stagingMemory);
vkBindBufferMemory(device, stagingBuffer, stagingMemory, 0);

// 3. CPU에서 스테이징 버퍼로 데이터 복사 (Coherent이므로 Flush 불필요)
void* pData;
vkMapMemory(device, stagingMemory, 0, dataSize, 0, &pData);
memcpy(pData, srcRawData, dataSize);
vkUnmapMemory(device, stagingMemory);

// 4. GPU 전송 커맨드 기록
VkBufferCopy copyRegion{};
copyRegion.size = dataSize;
vkCmdCopyBuffer(cmdBuffer, stagingBuffer, gpuBuffer, 1, &copyRegion);

// 5. 전송 완료 대기 후 스테이징 리소스 정리
vkWaitForFences(device, 1, &fence, VK_TRUE, UINT64_MAX);
vkFreeMemory(device, stagingMemory, nullptr);
vkDestroyBuffer(device, stagingBuffer, nullptr);
```

ReBAR(Resizable BAR)나 Smart Access Memory가 활성화된 시스템은 `DEVICE_LOCAL | HOST_VISIBLE`을 동시에 만족하는 대용량 힙이 존재한다. 이 경우 스테이징 버퍼를 거치지 않고 CPU가 VRAM에 바로 기록할 수 있다.

---

## 5. 버퍼-이미지 간격 제약 (`bufferImageGranularity`)

하나의 `VkDeviceMemory` 블록 안에 선형 리소스(버퍼, 선형 이미지)와 비선형 리소스(최적 타일링 이미지)를 함께 서브할당할 때는 `bufferImageGranularity` 제약을 준수해야 한다.

```c
// VkPhysicalDeviceLimits::bufferImageGranularity (통상 1KB ~ 64KB)
```

같은 메모리 블록 내에서 버퍼가 끝나는 지점과 이미지가 시작하는 지점 사이의 경계 오프셋은 반드시 `bufferImageGranularity`의 배수여야 한다.

```
메모리 블록: [ 0 ── 버퍼 A ── 256 ) [ 패딩 ] [ 4096 ── 이미지 B ── 8192 )
                                       ▲ bufferImageGranularity 정렬 경계
```

버퍼끼리만 연속 배치하거나 이미지만 연속 배치할 때는 이 제약이 적용되지 않는다. VMA(Vulkan Memory Allocator) 같은 메모리 라이브러리를 사용하면 리소스 풀을 분리하여 이 제약을 자동으로 해결해준다.

---

## 6. 전용 할당 (Dedicated Allocation)

일부 대형 렌더 타깃, 압축 텍스처, 또는 외부 API와 공유하는 메모리는 드라이버가 **단일 리소스 전용 할당**을 요구할 수 있다.

`VK_KHR_dedicated_allocation`(Vulkan 1.1 코어)은 메모리 할당 시점에 대상 리소스를 드라이버에 명시적으로 알린다.

```c
VkMemoryDedicatedRequirements dedReq{};
dedReq.sType = VK_STRUCTURE_TYPE_MEMORY_DEDICATED_REQUIREMENTS;

VkMemoryRequirements2 memReqs2{};
memReqs2.sType = VK_STRUCTURE_TYPE_MEMORY_REQUIREMENTS_2;
memReqs2.pNext = &dedReq;

VkImageMemoryRequirementsInfo2 imgInfo{};
imgInfo.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_REQUIREMENTS_INFO_2;
imgInfo.image = image;
vkGetImageMemoryRequirements2(device, &imgInfo, &memReqs2);

if (dedReq.requiresDedicatedAllocation) {
    VkMemoryDedicatedAllocateInfo dedAlloc{};
    dedAlloc.sType = VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO;
    dedAlloc.image = image;

    allocInfo.pNext = &dedAlloc;
    allocInfo.allocationSize = memReqs2.memoryRequirements.size;
    vkAllocateMemory(device, &allocInfo, nullptr, &memory);
    vkBindImageMemory(device, image, memory, 0); // 전용 할당 시 memoryOffset은 반드시 0
}
```

- 전용 할당으로 생성한 메모리는 해당 리소스가 독점하며 `memoryOffset`은 반드시 0이어야 한다.
- 서브할당이 불가능하므로 미세한 메모리 파편화가 발생할 수 있으나, 드라이버 레벨의 압축 메타데이터 최적화에는 유리하다.

---

## 7. 메모리 타입 선택 함수 (`findMemoryType`)

요구하는 속성 플래그를 충족하면서 리소스가 지원하는 메모리 타입 인덱스를 찾는 표준 구현이다.

```c
uint32_t findMemoryType(const VkPhysicalDeviceMemoryProperties& memProps,
                        uint32_t memoryTypeBits,
                        VkMemoryPropertyFlags requiredProps) {
    for (uint32_t i = 0; i < memProps.memoryTypeCount; ++i) {
        const bool typeSupported = (memoryTypeBits & (1 << i)) != 0;
        const bool propsSatisfied =
            (memProps.memoryTypes[i].propertyFlags & requiredProps) == requiredProps;

        if (typeSupported && propsSatisfied) {
            return i;
        }
    }
    return UINT32_MAX; // 적합한 메모리 타입을 찾지 못함
}
```

Vulkan 스펙은 메모리 타입 목록이 **부분집합 순서**로 정렬되어 있음을 보장한다. 즉, 속성 플래그 수가 적은 타입이 더 앞쪽 인덱스에 배치된다. 따라서 단순 순차 탐색만으로도 불필요한 플래그가 붙지 않은 최적의 메모리 타입을 먼저 선택할 수 있다.

---

## 8. 실무 메모리 구성 요약

| 용도 | 권장 메모리 속성 조합 | 설명 |
|---|---|---|
| 정적 메시, 인덱스, 텍스처 | `DEVICE_LOCAL` | GPU 전용 최고 대역폭 메모리 |
| CPU 업로드 (스테이징 버퍼) | `HOST_VISIBLE \| HOST_COHERENT` | 쓰기 속도 준수, 명시적 동기화 불필요 |
| 매 프레임 갱신 유니폼 버퍼 | `HOST_VISIBLE \| HOST_COHERENT` 또는 `DEVICE_LOCAL \| HOST_VISIBLE` | ReBAR 지원 시 VRAM 직접 기록 |
| 리드백 버퍼 (쿼리, 스크린샷) | `HOST_VISIBLE \| HOST_CACHED` (`HOST_COHERENT` 권장) | CPU 읽기 캐싱 필수 |
| 임시 렌더 타깃 (MSAA, 깊이) | `DEVICE_LOCAL \| LAZILY_ALLOCATED` | 물리 메모리 소비를 줄이는 지연 할당 |

Vulkan Memory Allocator(VMA) 라이브러리를 사용하면 위와 같은 메모리 타입 선택, 블록 청크 관리, 버퍼-이미지 간격 정렬, 전용 할당 판별 등을 자동으로 처리할 수 있다.
