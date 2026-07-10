---
title: 메모리
slug: memory
---

## 소개

Vulkan에서 **메모리 관리**는 애플리케이션의 몫이다. OpenGL처럼 GPU가 알아서 해주지 않는다. 메모리 타입 선택, 정렬, 캐시 정책까지 직접 결정해야 하지만, 그만큼 최적화 여지가 크다.

> **용어 정리**
> - **VRAM**: GPU가 가진 전용 메모리. 접근이 가장 빠르다
> - **Staging Buffer**: CPU와 GPU 사이에 데이터를 옮기는 중계용 버퍼
> - **Memory Type**: 메모리의 접근 속성 (캐시 여부, 가시성 등)
> - **Memory Heap**: 물리적 메모리 풀 (VRAM 또는 시스템 RAM)

---

## 1. `VkMemoryRequirements` — 메모리 요구사항

모든 버퍼와 이미지를 생성한 후, `vkGetBufferMemoryRequirements` / `vkGetImageMemoryRequirements`로 필요한 메모리 정보를 조회한다.

> **용도** GPU는 리소스마다 "얼마나 큰 메모리가 필요한지", "어떤 정렬이 필요한지"가 다르다. 이 정보를 조회하지 않고 마음대로 할당하면 에러가 발생한다.

```c
typedef struct VkMemoryRequirements {
    VkDeviceSize    size;          // 필요한 메모리 크기 (bytes)
    VkDeviceSize    alignment;     // offset 정렬 요구사항 (2의 거듭제곱)
    uint32_t        memoryTypeBits;// 지원되는 메모리 타입 비트마스크
} VkMemoryRequirements;
```

- `size`: 이 리소스가 필요로 하는 최소 메모리 크기
- `alignment`: `vkBindBufferMemory` / `vkBindImageMemory`의 `memoryOffset`이 이 값의 배수여야 함. **항상 2의 거듭제곱**
- `memoryTypeBits`: bit i가 1이면 memory type i를 이 리소스에 사용할 수 있음

```c
VkMemoryRequirements memReqs;
vkGetBufferMemoryRequirements(device, buffer, &memReqs);
// memReqs.alignment: 보통 64 또는 256
// memReqs.memoryTypeBits: 여러 메모리 타입 중 선택 가능한 것들
```

---

### 1.1. Buffer Alignment와 Usage

버퍼 alignment는 리소스의 usage에 따라 추가 제약이 있다:

| Usage 포함 | 추가 alignment 제약 |
|-----------|-------------------|
| `UNIFORM_BUFFER` | `minUniformBufferOffsetAlignment`의 배수 (보통 256) |
| `STORAGE_BUFFER` | `minStorageBufferOffsetAlignment`의 배수 (보통 256) |
| `UNIFORM_TEXEL_BUFFER` / `STORAGE_TEXEL_BUFFER` | `minTexelBufferOffsetAlignment`의 배수 |

```c
// UBO의 dynamic offset은 반드시 256바이트 정렬
VkPhysicalDeviceLimits limits;
vkGetPhysicalDeviceProperties(physDev, &props);
// props.limits.minUniformBufferOffsetAlignment = 256 (일반적)
```

이 값들은 `VkPhysicalDeviceLimits`에서 확인 가능하다.

---

### 1.2. 이미지 Alignment 특성

이미지의 alignment는 tiling 방식에 따라 달라진다:

- **Linear tiling**: 행 단위로 정렬. CPU에서 직접 접근 가능하지만 성능이 낮음.
- **Optimal tiling**: alignment가 하드웨어 최적화되어 있음. GPU 전용.

`maintenance4` feature가 활성화되어 있으면, 같은 `VkImageCreateInfo` 핵심 파라미터로 만든 이미지들은 `VkMemoryRequirements::alignment`가 항상 같다.

여기서 비교 대상은 다음 멤버들이다:

- `flags`
- `imageType`
- `format`
- `extent`
- `mipLevels`
- `arrayLayers`
- `samples`
- `tiling`
- `usage`

즉 위 값들이 모두 같은 이미지 A/B를 만들고 각각 `vkGetImageMemoryRequirements`를 호출하면, 반환된 `alignment`는 같은 값이어야 한다. 이 보장은 이미지별로 매번 다른 alignment가 나올 수 있다고 가정하지 않아도 되게 해주므로, 같은 종류의 이미지를 많이 할당하는 allocator에서 alignment를 캐시하기 좋다.

단, 이 말은 `size`나 `memoryTypeBits`까지 항상 같다는 뜻은 아니다. 여기서 명확히 보장하는 것은 **alignment 동일성**이다.

---

## 2. 메모리 타입과 힙 — `VkPhysicalDeviceMemoryProperties`

디바이스가 제공하는 메모리 구조는 `VkPhysicalDeviceMemoryProperties`로 조회한다.

```c
typedef struct VkPhysicalDeviceMemoryProperties {
    uint32_t        memoryTypeCount;
    VkMemoryType    memoryTypes[VK_MAX_MEMORY_TYPES];   // 최대 32개
    uint32_t        memoryHeapCount;
    VkMemoryHeap    memoryHeaps[VK_MAX_MEMORY_HEAPS];   // 최대 16개
} VkPhysicalDeviceMemoryProperties;
```

**Heap**은 물리적 메모리 풀 (VRAM, 시스템 RAM), **Memory Type**은 heap의 접근 속성(캐시/가시성) 조합이다.

```c
typedef struct VkMemoryHeap {
    VkDeviceSize         size;
    VkMemoryHeapFlags    flags;
} VkMemoryHeap;

typedef struct VkMemoryType {
    VkMemoryPropertyFlags    propertyFlags;
    uint32_t                 heapIndex;  // 이 타입이 속한 heap
} VkMemoryType;
```

---

### 2.1. Memory Property Flags

각 메모리 타입은 `propertyFlags`로 다음과 같은 속성을 가진다:

```c
enum VkMemoryPropertyFlagBits {
    VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT         = 0x00000001,
    VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT         = 0x00000002,
    VK_MEMORY_PROPERTY_HOST_COHERENT_BIT        = 0x00000004,
    VK_MEMORY_PROPERTY_HOST_CACHED_BIT          = 0x00000008,
    VK_MEMORY_PROPERTY_LAZILY_ALLOCATED_BIT     = 0x00000010,
    VK_MEMORY_PROPERTY_PROTECTED_BIT            = 0x00000020,
    VK_MEMORY_PROPERTY_DEVICE_COHERENT_BIT_AMD  = 0x00000040,
    VK_MEMORY_PROPERTY_DEVICE_UNCACHED_BIT_AMD  = 0x00000080,
    VK_MEMORY_PROPERTY_RDMA_CAPABLE_BIT_NV      = 0x00000100,
};
```

**각 플래그의 의미:**

| 플래그 | 의미 |
|-------|------|
| `DEVICE_LOCAL` | GPU 접근이 가장 빠름 (VRAM). VRAM heap에 속한 타입에만 설정됨 |
| `HOST_VISIBLE` | CPU가 `vkMapMemory`로 맵핑 가능 |
| `HOST_COHERENT` | CPU-GPU 간 **자동 가시성 보장**. Flush/Invalidate 불필요 |
| `HOST_CACHED` | CPU 측에서 캐시됨. 읽기 성능 향상 |
| `LAZILY_ALLOCATED` | 실제 사용 시에만 물리 메모리 할당. Transient attachment 용도<br>스펙: *"if the image did not have VK_IMAGE_USAGE_TRANSIENT_ATTACHMENT_BIT... must not refer to a VkMemoryType with LAZILY_ALLOCATED_BIT"* → 일반 버퍼/텍스처에는 사용 불가. Transient attachment 전용이다.
| `PROTECTED` | 보호된 메모리. 보안 큐(Protected Queue)를 통해서만 접근 가능하며, **Host(CPU)에서는 `vkMapMemory` 등을 통해 절대 접근할 수 없음** |
| `DEVICE_COHERENT_AMD` | GPU 측 자동 가시성 (쓰기가 즉시 GPU에 보임) |
| `DEVICE_UNCACHED_AMD` | GPU 캐시 안 함. 느리지만 항상 coherent |

---

### 2.3. 보안 큐 (Protected Queue)와 보호된 메모리

`VK_MEMORY_PROPERTY_PROTECTED_BIT`가 설정된 메모리는 일반적인 방법으로는 접근할 수 없는 **보안 영역**이다. 이를 관리하기 위해 Vulkan은 **보안 큐(Protected Queue)** 개념을 도입했다.

- **보안 큐의 역할**: 보호된 메모리에 접근할 수 있는 전용 권한을 가진 큐다. 오직 이 큐를 통해 제출된 명령만이 보호된 메모리를 읽거나 쓸 수 있다.
- **Host 접근 완전 차단**: 보안성이 최우선이므로, CPU는 `vkMapMemory`를 통해 이 영역에 접근하는 것이 완전히 금지된다. 맵핑을 시도하면 에러가 발생하거나 데이터가 읽히지 않는다.
- **주요 용도 (DRM)**: 4K 블루레이나 넷플릭스 같은 고화질 콘텐츠의 비디오 디코딩 데이터 보호에 주로 사용된다. 메모리 덤프를 통한 원본 영상 유출을 하드웨어 레벨에서 막기 위함이다.
- **격리된 경로**: 보호된 메모리를 사용하는 셰이더 역시 "보호됨" 상태여야 하며, 결과물 또한 보안 출력 경로(Secure Display Path)를 통해서만 화면에 출력될 수 있다.

즉, **보안 큐는 "GPU 내부의 금고"에 접근할 수 있는 유일한 열쇠**와 같으며, 설령 시스템 권한을 가진 CPU라 할지라도 이 금고 내부를 직접 들여다볼 수는 없다.

스펙은 `DEVICE_COHERENT_AMD`와 `DEVICE_UNCACHED_AMD`가 동시에 설정된 조합에 대해 다음과 같이 경고한다:

> Device coherent accesses may be slower than equivalent accesses without device coherence, particularly if they are also device uncached.
>> 디바이스 코히런트 접근은 일반 접근보다 느릴 수 있으며, 특히 **디바이스 언캐시드(Device Uncached) 속성이 동시에 설정되어 있다면 성능 저하가 더욱 심해진다.** 따라서 정말 필요한 경우가 아니면 이 두 속성을 동시에 사용하는 것은 권장되지 않는다.

---

### 2.2. 자주 보이는 메모리 타입 조합

스펙이 허용하는 조합 중 실제로 흔한 것들:

```
# 전용 GPU (NVIDIA, AMD dGPU)
Type 0: DEVICE_LOCAL                                    → VRAM (vertex, texture, render target)
Type 1: HOST_VISIBLE | HOST_COHERENT                    → 스테이징 업로드 (non-cached)
Type 2: HOST_VISIBLE | HOST_CACHED | HOST_COHERENT      → 리드백 (CPU 읽기)
Type 3: DEVICE_LOCAL | HOST_VISIBLE | HOST_COHERENT     → ReBAR 지원 시 (있을 수도 없을 수도)

# 통합 GPU (Intel UHD, Apple M1, AMD APU)
Type 0: DEVICE_LOCAL | HOST_VISIBLE | HOST_COHERENT     → UMA (CPU-GPU 같은 메모리)
Type 1: HOST_VISIBLE | HOST_COHERENT                    → 스테이징
Type 2: HOST_VISIBLE | HOST_CACHED | HOST_COHERENT      → 리드백
```

스펙은 다음을 보장한다:
- `HOST_VISIBLE | HOST_COHERENT` 조합이 **적어도 하나는 존재**함
- `DEVICE_LOCAL`이 **적어도 하나는 존재**함
- `HOST_VISIBLE | HOST_COHERENT | HOST_CACHED`는 있을 수도 있고 없을 수도 있음 (모바일/내장 GPU에 따라 다름)

---

## 3. Cached vs Non-cached — 캐시 정책의 이해

`HOST_CACHED` 비트 유무가 CPU 캐시 동작을 결정한다.

> **핵심 개념**: CPU는 메모리 접근 시 캐시를 사용한다. Cached 메모리는 CPU가 읽을 때 빠르지만, GPU와 데이터 일관성을 수동으로 관리해야 할 수 있다. Non-cached는 항상 일관성이 보장되지만 CPU 읽기가 느리다.

| 항목 | **Cached** (`HOST_CACHED`) | **Non-cached** |
|------|--------------------------|----------------|
| CPU 읽기 속도 | 빠름 (L1/L2 캐시 히트) | 느림 (매번 DRAM 접근, 캐시 바이패스) |
| CPU 쓰기 속도 | 빠름 (캐시라인에 쓰기) | write-combined (GPU 읽기에 최적화) |
| Coherency | 자동 아님 → `vkInvalidateMappedMemoryRanges` / `vkFlushMappedMemoryRanges` 필요 | `HOST_COHERENT`와 조합 시 자동 보장 |
| 주요 사용처 | GPU → CPU 리드백 (query, screenshot) | CPU → GPU 업로드 (스테이징 버퍼) |

스펙 원문:

> Host memory accesses to uncached memory are slower than to cached memory, **however uncached memory is always host coherent.**
>> non-cached 메모리는 항상 host coherent가 보장된다. 즉 `HOST_VISIBLE | HOST_COHERENT`는 무조건 non-cached다. 반면 cached + coherent는 있을 수도 없을 수도 있음.

즉 **non-cached + coherent는 항상 보장**되지만, **cached + coherent는 선택사항**이다. cached 타입이 없으면 CPU 읽기가 필요한 readback에서 성능 저하가 발생할 수 있다.

### 3.1. Flush / Invalidate가 필요한 상황

`HOST_COHERENT`가 **없는** 메모리 타입을 쓸 때는 명시적 Flush/Invalidate가 필요하다.

```c
// Non-coherent 메모리: CPU가 쓴 뒤 GPU가 읽기 전에 반드시 Flush
void* data;
vkMapMemory(device, memory, 0, VK_WHOLE_SIZE, 0, &data);
memcpy(data, src, size);

VkMappedMemoryRange range{};
range.memory = memory;
range.offset = 0;
range.size = VK_WHOLE_SIZE;
vkFlushMappedMemoryRanges(device, 1, &range);  // CPU cache → GPU에 보이게

// GPU가 쓴 뒤 CPU가 읽기 전에 반드시 Invalidate
vkWaitForFences(device, 1, &fence, VK_TRUE, UINT64_MAX);
vkInvalidateMappedMemoryRanges(device, 1, &range);  // GPU cache → CPU에 보이게
// 이제 data 읽기 가능
```

`HOST_COHERENT`가 있으면 이 모든 과정이 필요 없음. 대신 non-cached면 CPU 읽기가 느림.

### 3.2. HOST_CACHED를 쓰는 이유

`HOST_CACHED` 메모리는 CPU가 **읽을 일이 많을 때** 선택한다. non-cached(write-combined)는 GPU가 읽기에 최적화되어 있어 CPU 쓰기는 빠르지만 CPU 읽기는 매우 느리다.

**캐시의 장점:**
- CPU 읽기 속도가 L1/L2 캐시 히트 기준으로 **수십 배 빠름** (몇 백 GB/s vs DRAM 대역폭)
- 자주 읽는 데이터를 반복 접근할 때 캐시 히트율이 높아지면 성능 차이가 극명함
- `HOST_COHERENT`가 함께 있으면 Flush/Invalidate 없이도 자동 동기화

**HOST_CACHED가 필요한 대표적인 상황:**

| 사용 사례 | 캐시가 필요한 이유 | 비고 |
|-----------|-------------------|------|
| GPU query 결과 읽기 (occlusion, timestamp, statistics) | CPU가 결과 폴링, 캐시 없으면 매번 DRAM 접근 → 대기 시간 증가 | `vkGetQueryPoolResults`로 읽음 |
| Screenshot / Render target readback | 프레임 한 장 픽셀 데이터를 CPU로 복사 | 용량이 크면 캐시 효과 큼 |
| GPU 가속 연산 결과 수집 (compute shader output) | 파티클 위치, 물리 시뮬레이션 결과 등을 CPU가 읽음 | 매 프레임 또는 간헐적 readback |
| Indirect draw count / draw indirect 결과 확인 | CPU 디버깅 또는 fallback 결정 | 조건부 로직 |

**주의할 점:**
- Cached + non-coherent 조합이면 Flush/Invalidate 관리가 까다로움. 깜빡하면 stale 데이터 읽음 → 가능하면 `HOST_COHERENT`도 함께 있는 타입을 찾는 게 좋음
- GPU가 주로 읽는 용도(vertex buffer, texture upload)에는 non-cached가 적합. cached 메모리에 GPU가 쓰고 CPU가 읽는 경우는 캐시 무효화(invalidate) 비용이 추가됨
- Readback용 버퍼는 **CPU 읽기 전에 Invalidate를 잊지 말 것** (coherent가 아닌 경우)

**실전 팁:** 데스크톱 GPU(NVIDIA, AMD)에는 보통 `HOST_VISIBLE | HOST_CACHED | HOST_COHERENT` 타입이 존재한다. 모바일/내장 GPU에는 없을 수 있으므로, 반드시 `findMemoryType`으로 존재 여부를 확인한 후 사용해야 한다.

---

## 4. Staging Buffer 패턴

가장 일반적인 패턴: CPU에서 데이터를 준비해서 GPU 전용 메모리로 복사한다.

> **용도** GPU 전용 메모리(DEVICE_LOCAL)는 CPU가 직접 쓸 수 없다. 그래서 CPU가 접근 가능한 Staging Buffer에 데이터를 만들어 넣은 다음, 데이터를 원본 리소스에 옮긴다. 단, DEVICE_LOCAL | HOST_VISIBLE 속성이 같이 있으면 CPU가 쓸 수 있으면서 gpu 가 읽을수 있는 타입이기 때문에 따로 Staging Buffer 를 만들지 않아도 된다.

```relflow
cpu: CPU (HOST_VISIBLE)
gpu: GPU (DEVICE_LOCAL)
---
Staging Buffer | Vertex Buffer
(non-cached) | Texture 등
HOST_COHERENT | (GPU 전용)
---
foot: left
vkMapMemory
memcpy (CPU 입력/출력)
```

```c
// 1. 최종 리소스 (DEVICE_LOCAL)
VkBufferCreateInfo bufCI{};
bufCI.size = dataSize;
bufCI.usage = VK_BUFFER_USAGE_VERTEX_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
vkCreateBuffer(device, &bufCI, nullptr, &gpuBuffer);

VkMemoryRequirements memReqs;
vkGetBufferMemoryRequirements(device, gpuBuffer, &memReqs);

VkMemoryAllocateInfo allocInfo{};
allocInfo.allocationSize = memReqs.size;
allocInfo.memoryTypeIndex = findMemoryType(memReqs.memoryTypeBits,
    VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
VkDeviceMemory gpuMemory;
vkAllocateMemory(device, &allocInfo, nullptr, &gpuMemory);
vkBindBufferMemory(device, gpuBuffer, gpuMemory, 0);

// 2. Staging buffer
bufCI.usage = VK_BUFFER_USAGE_TRANSFER_SRC_BIT;
vkCreateBuffer(device, &bufCI, nullptr, &stagingBuffer);
vkGetBufferMemoryRequirements(device, stagingBuffer, &memReqs);

allocInfo.allocationSize = memReqs.size;
allocInfo.memoryTypeIndex = findMemoryType(memReqs.memoryTypeBits,
    VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
// non-cached + coherent: CPU 쓰기용 최적
VkDeviceMemory stagingMemory;
vkAllocateMemory(device, &allocInfo, nullptr, &stagingMemory);
vkBindBufferMemory(device, stagingBuffer, stagingMemory, 0);

// 3. CPU 데이터 쓰기 (coherent이므로 Flush 불필요)
void* data;
vkMapMemory(device, stagingMemory, 0, dataSize, 0, &data);
memcpy(data, srcData, dataSize);
vkUnmapMemory(device, stagingMemory);

// 4. Staging → GPU 복사 (커맨드 버퍼에서)
VkBufferCopy copyRegion{};
copyRegion.size = dataSize;
vkCmdCopyBuffer(cmdBuffer, stagingBuffer, gpuBuffer, 1, &copyRegion);

// 5. (선택) Staging 메모리 해제
vkFreeMemory(device, stagingMemory, nullptr);
vkDestroyBuffer(device, stagingBuffer, nullptr);
```

**메모리 타입 선택 기준:**
| 용도 | 권장 | 이유 |
|------|------|------|
| CPU → GPU 업로드 | `HOST_VISIBLE` + `HOST_COHERENT` (non-cached) | write-combined, GPU 읽기에 최적 |
| CPU ← GPU 리드백 | `HOST_VISIBLE` + `HOST_CACHED` + `HOST_COHERENT` | CPU 읽기 성능 중요 |
| GPU 전용 렌더 데이터 | `DEVICE_LOCAL` | 가장 빠른 GPU 접근 |
| Transient attachment | `DEVICE_LOCAL` + `LAZILY_ALLOCATED` | 실제 쓰는 만큼만 할당 |
| APU/UMA 시스템 | `DEVICE_LOCAL` + `HOST_VISIBLE` + `HOST_COHERENT` | CPU-GPU 같은 메모리 활용 |

---

## 5. Buffer-Image Granularity

하나의 `VkDeviceMemory`에 버퍼와 이미지를 **같이 넣을 때**는 `bufferImageGranularity` 제약이 있다.

> **이유** GPU 하드웨어마다 버퍼와 이미지를 메모리에 배치하는 방식이 다르다. 이 둘을 섞어 놓으면 성능이 떨어질 수 있어서, GPU가 정한 정렬 단위를 지키라고 요구한다.

```c
// VkPhysicalDeviceLimits::bufferImageGranularity
// 보통 1024~65536 사이
```

**규칙:** 같은 할당 내에서 **버퍼가 끝나는 지점과 이미지가 시작하는 지점** 사이의 경계는 `bufferImageGranularity`의 배수여야 한다.

```
할당: [0 ─── 버퍼 A ─── 256) [256 ─── 이미지 B ─── 512)
                         ↑ bufferImageGranularity 정렬 필요!
```

즉 메모리 블록 하나에 여러 리소스를 **수동으로 offset 계산해서 넣을 때**, 버퍼-이미지 사이에 패딩이 생길 수 있다. 버퍼만 연속 배치하거나 이미지만 연속 배치하는 경우에는 이 제약이 적용되지 않는다.

**완전히 회피하는 방법:**
- VMA(Vulkan Memory Allocator) 사용
- 또는 리소스당 하나의 메모리 할당 (Dedicated Allocation)

---

## 6. Dedicated Allocation (전용 할당)

일부 리소스는 **자신만의 전용 메모리 할당**을 요구할 수 있다. 특히 외부 메모리(import)나 대형 이미지에서 자주 발생한다.

> **언제 필요할까?** 드라이버가 "이 이미지는 별도 메모리에 넣어야 효율적이다"라고 판단하면 dedicated allocation을 요구한다. 보통 큰 렌더 타깃이나 외부에서 가져온 리소스에서 발생한다.

```c
VkMemoryDedicatedRequirements dedReq{};
dedReq.sType = VK_STRUCTURE_TYPE_MEMORY_DEDICATED_REQUIREMENTS;
VkMemoryRequirements2 memReqs2{};
memReqs2.sType = VK_STRUCTURE_TYPE_MEMORY_REQUIREMENTS_2;
memReqs2.pNext = &dedReq;

VkImageMemoryRequirementsInfo2 imgInfo{};
imgInfo.image = image;
vkGetImageMemoryRequirements2(device, &imgInfo, &memReqs2);

if (dedReq.requiresDedicatedAllocation) {
    // 전용 할당 필수: memoryOffset은 반드시 0
    VkMemoryDedicatedAllocateInfo dedAlloc{};
    dedAlloc.sType = VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO;
    dedAlloc.image = image;  // 또는 buffer
    allocInfo.pNext = &dedAlloc;
}

vkAllocateMemory(device, &allocInfo, nullptr, &memory);
vkBindImageMemory(device, image, memory, 0);
```

전용 할당의 특징:

- `memoryOffset`은 반드시 0
- 메모리 블록 하나를 해당 리소스가 독점
- 다른 리소스와 공유 불가 (약간의 메모리 낭비 가능)
- `VK_KHR_dedicated_allocation` (Vulkan 1.1 core)로 표준화
- 스펙: *"If buffer requires a dedicated allocation... memory must have been allocated with VkMemoryDedicatedAllocateInfo::buffer equal to buffer"* → 전용 할당이 요구되면 반드시 해당 리소스 전용으로만 할당해야 함, memoryOffset = 0

---

## 7. 메모리 타입 선택 함수 (findMemoryType)

메모리 타입을 선택하는 전형적인 함수다.

> **동작 원리**: 1) 리소스가 지원하는 타입 비트마스크 확인, 2) 원하는 속성(DEVICE_LOCAL, HOST_VISIBLE 등)을 모두 만족하는 타입 찾기. 스펙이 타입을 "부분집합 순서"로 정렬한다고 보장해서, 먼저 찾은 것이 최적이다.

```c
uint32_t findMemoryType(const VkPhysicalDeviceMemoryProperties* memProps,
                        uint32_t memoryTypeBits,
                        VkMemoryPropertyFlags requiredProps) {
    const uint32_t count = memProps->memoryTypeCount;
    for (uint32_t i = 0; i < count; i++) {
        const bool typeSupported = (memoryTypeBits & (1 << i)) != 0;
        const bool propsSupported =
            (memProps->memoryTypes[i].propertyFlags & requiredProps) == requiredProps;
        if (typeSupported && propsSupported) {
            return i;
        }
    }
    // 찾을 수 없음 → fallback 또는 에러
    return UINT32_MAX;
}
```

스펙은 메모리 타입이 **하위 집합 순서**로 정렬되어 있음을 보장한다:

> If the set of bit flags returned in the propertyFlags member of X is a strict subset of the set of bit flags returned in the propertyFlags member of Y; X must be placed at a lower index position than Y.
>> 플래그가 적은 타입(부분집합)이 앞쪽 인덱스에 온다. `DEVICE_LOCAL`만 있는 타입이 `DEVICE_LOCAL | HOST_VISIBLE`보다 먼저 나온다. 따라서 단순 순차 검색(findMemoryType)만으로 원하는 최적 타입을 찾을 수 있다.

---

## 8. 실전: 엔진에서 메모리 분류 예시

실제 엔진에서는 리소스 용도별로 메모리를 분류해서 관리한다.

> **팁**: VMA(Vulkan Memory Allocator)를 사용하면 이런 분류와 서브할당을 자동으로 처리해준다. 수동 관리가 필요하다면 아래 분류를 참고하자.

- **DEVICE_LOCAL (VRAM)**
  - Vertex buffers
  - Index buffers
  - Textures (optimal tiling)
  - Render targets
  - Uniform buffers (성능 중요)
- **HOST_VISIBLE + HOST_COHERENT (Staging)**
  - Upload buffers (CPU → GPU)
  - Dynamic uniform buffers (매프레임 갱신) DEVICE_LOCAL 까지 있으면 더 좋음.
- **HOST_VISIBLE + HOST_CACHED + HOST_COHERENT**
  - Readback buffers (GPU → CPU) CPU에서 읽기 : HOST_CACHED 가 있어야 빠르다.
  - Query results
- **LAZILY_ALLOCATED**
  - Depth/stencil transient attachments
  - MSAA color resolve targets

VMA(Vulkan Memory Allocator)를 사용하면 이런 메모리 타입 선택과 서브할당을 자동으로 처리해준다. 수동 관리가 필요하다면 각 리소스 카테고리별로 별도의 메모리 블록을 관리하는 것이 안전하다.
