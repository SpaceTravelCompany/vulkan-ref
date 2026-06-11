---
title: Sampler
slug: samplers
---

## 소개

`VkSampler`는 **셰이더가 이미지를 어떻게 샘플링할지** 결정하는 immutable 객체다. 필터, address mode, LOD, anisotropy, PCF 비교 등 **한번 만들면 바꿀 수 없는 설정**을 묶어서 디스크립터에 함께 묶거나 따로 바인딩한다.

> **용어 정리**
> - **Filter**: 멀티플 샘플(linear) vs 단일 샘플(nearest).
> - **Address Mode**: uv 좌표가 [0,1] 밖일 때 동작 (repeat, clamp, mirror, ...).
> - **Mipmap Mode**: mip 간 보간 (linear/nearest).
> - **LOD Bias**: 계산된 LOD에 더하는 bias. 부적절하면 aliasing/blur.
> - **Anisotropy**: 비등방 샘플링. 비스듬한 표면에서 품질 향상.
> - **PCF (Percentage-Closer Filtering)**: 깊이 비교 샘플의 보간. 그림자 가장자리 부드럽게.
> - **Unnormalized Coordinates**: [0,1] 대신 픽셀 단위 좌표 (2D 텍셀 인덱스).

이 문서는 `VkSamplerCreateInfo`의 모든 필드와 자주 빠지는 주의사항을 다룬다.

---

---

## 1. `VkSamplerCreateInfo` — 큰 구조

```c
typedef struct VkSamplerCreateInfo {
    VkStructureType          sType;
    const void*              pNext;
    VkSamplerCreateFlags     flags;
    VkFilter                 magFilter;
    VkFilter                 minFilter;
    VkSamplerMipmapMode      mipmapMode;
    VkSamplerAddressMode     addressModeU;
    VkSamplerAddressMode     addressModeV;
    VkSamplerAddressMode     addressModeW;
    float                    mipLodBias;
    VkBool32                 anisotropyEnable;
    float                    maxAnisotropy;
    VkBool32                 compareEnable;
    VkCompareOp              compareOp;
    float                    minLod;
    float                    maxLod;
    VkBorderColor            borderColor;
    VkBool32                 unnormalizedCoordinates;
} VkSamplerCreateInfo;
```

> **스펙 원문 (Note)** "Some implementations will default to shader state if this member does not match." (compareEnable 주석)
>> 일부 구현은 셰이더 상태(예: `OpTypeSampledImage`의 depth-compare 속성)와 sampler의 `compareEnable`이 다르면 셰이더 쪽을 따르기도 한다. 포터블하게 쓰려면 일치시켜야 함.

---

---

## 2. 필터 — `magFilter` / `minFilter` / `mipmapMode`

| 필드 | 의미 | 일반 값 |
|------|------|---------|
| `magFilter` | 확대 시 (texel < pixel) | `NEAREST` (픽셀아트) / `LINEAR` (부드럽게) |
| `minFilter` | 축소 시 (texel > pixel) | `LINEAR` 권장 |
| `mipmapMode` | mip 간 보간 | `NEAREST` (성능) / `LINEAR` (품질) |

> **스펙 원문 (VkFilter 정의)** `VK_FILTER_NEAREST`, `VK_FILTER_LINEAR`, `VK_FILTER_CUBIC_EXT`(`VK_IMG_filter_cubic` alias). 큐빅은 `VK_EXT_filter_cubic`이 활성화된 디바이스에서만. 큐빅 사용 시 `anisotropyEnable = VK_FALSE` 강제 (VUID-VkSamplerCreateInfo-magFilter-01081).

**권장 조합:**

| 용도 | mag | min | mipmap | 비고 |
|------|-----|-----|--------|------|
| 3D 씬 일반 | LINEAR | LINEAR | LINEAR | 트릴리니어 |
| 픽셀아트 2D | NEAREST | NEAREST | NEAREST | 격자 유지 |
| 그림자 맵 (PCF) | LINEAR | LINEAR | NEAREST | 안티에일리어싱 |
| 성능 최우선 | LINEAR | NEAREST | NEAREST | 빌리니어 |

---

---

## 3. Address Mode — `addressModeU/V/W`

uv 좌표가 [0, 1] 밖일 때 동작. UV는 이미지 평면 축마다 적용 (W는 3D 텍스처).

| 모드 | 동작 | 흔한 용도 |
|------|------|----------|
| `REPEAT` | uv mod 1 (타일링) | 벽 바닥 텍스처 |
| `MIRRORED_REPEAT` | 매번 미러링하며 반복 | 대칭 패턴 |
| `CLAMP_TO_EDGE` | 가장자리 픽셀로 클램프 | UI, 데칼 |
| `CLAMP_TO_BORDER` | `borderColor`로 채움 | 글로우/halo, 큐브 단일 면 |
| `MIRROR_CLAMP_TO_EDGE` | 미러 1회 후 엣지 클램프 | 반사 텍스처 (1.2+) |

> **스펙 원문 (VUID-VkSamplerCreateInfo-addressModeU-01079)** If the `samplerMirrorClampToEdge` feature is not enabled, and if the `VK_KHR_sampler_mirror_clamp_to_edge` extension is not enabled, `addressModeU/V/W` must not be `MIRROR_CLAMP_TO_EDGE`.
>> `MIRROR_CLAMP_TO_EDGE`는 **Vulkan 1.2 또는 extension** 필요. 1.0/1.1 디바이스에서는 못 씀.

> **스펙 원문 (VUID-VkSamplerCreateInfo-addressModeU-01078)** If any of `addressModeU/V/W` are `CLAMP_TO_BORDER`, `borderColor` must be a valid `VkBorderColor` value.
>> border를 쓸 거면 `borderColor` 명시 필수.

> **스펙 원문 (VUID-VkSamplerCreateInfo-addressModeU-01646)** If sampler Y′CBCR conversion is enabled, `addressModeU/V/W` must be `CLAMP_TO_EDGE`, `anisotropyEnable` must be `VK_FALSE`, and `unnormalizedCoordinates` must be `VK_FALSE`.
>> YCbCr 변환에는 address가 CLAMP_TO_EDGE만, anisotropy/비정규화 금지.

**Border 색 (`VkBorderColor`):**

| 값 | 의미 |
|----|------|
| `FLOAT_TRANSPARENT_BLACK` | (0,0,0,0) — 가장 일반적 |
| `INT_TRANSPARENT_BLACK` | (0,0,0,0) 정수형 |
| `FLOAT_OPAQUE_BLACK` / `FLOAT_OPAQUE_WHITE` | 디버깅용 |
| `FLOAT_CUSTOM_EXT` / `INT_CUSTOM_EXT` | 임의 색 (customBorderColors feature) |

> **스펙 원문 (VUID-VkSamplerCreateInfo-borderColor-04011)** If `borderColor` is `FLOAT_CUSTOM_EXT` or `INT_CUSTOM_EXT`, then a `VkSamplerCustomBorderColorCreateInfoEXT` must be included in the pNext chain.
>> 커스텀은 별도 pNext 구조로 색 전달.

---

---

## 4. Mipmap / LOD — `mipmapMode`, `mipLodBias`, `minLod`, `maxLod`

```c
samplerInfo.mipmapMode = VK_SAMPLER_MIPMAP_MODE_LINEAR;  // 트릴리니어
samplerInfo.mipLodBias  = 0.0f;
samplerInfo.minLod      = 0.0f;
samplerInfo.maxLod      = VK_LOD_CLAMP_NONE;  // 클램프 없음
```

| 필드 | 의미 | 비고 |
|------|------|------|
| `mipmapMode` | mip 간 보간 | 트릴리너 = `LINEAR` |
| `mipLodBias` | LOD 계산에 더할 bias | 부적절하면 blur(-) 또는 aliasing(+) |
| `minLod` | LOD 최소 (clamp) | sharpest mip보다 큰 값이면 sharpest 사용 |
| `maxLod` | LOD 최대 (clamp) | `VK_LOD_CLAMP_NONE` (= 1000.0f) → 클램프 없음 |

> **스펙 원문 (VUID-VkSamplerCreateInfo-mipLodBias-01069)** The absolute value of `mipLodBias` must be less than or equal to `VkPhysicalDeviceLimits::maxSamplerLodBias`.
>> device 한계를 넘어서면 안 됨 (보통 0~16 사이).

> **스펙 원문 (VUID-VkSamplerCreateInfo-maxLod-01973)** `maxLod` must be greater than or equal to `minLod`.
>> `maxLod < minLod`은 무효. 보통 `minLod=0`, `maxLod=VK_LOD_CLAMP_NONE`.

**권장:**

- 텍스처 mipmap이 잘 만들어진 경우 → `LINEAR` + `minLod=0` + `maxLod=VK_LOD_CLAMP_NONE` + `mipLodBias=0`
- LOD blur를 일부러 강하게 하고 싶을 때 → `mipLodBias` 양수
- 그림자맵처럼 좁은 LOD 범위만 쓰고 싶을 때 → `minLod=2`, `maxLod=4`

---

---

## 5. Anisotropy — `anisotropyEnable`, `maxAnisotropy**

```c
// samplerAnisotropy feature 활성화 필요
samplerInfo.anisotropyEnable = VK_TRUE;
samplerInfo.maxAnisotropy    = 16.0f;  // 1.0 ~ VkPhysicalDeviceLimits::maxSamplerAnisotropy
```

| 필드 | 의미 |
|------|------|
| `anisotropyEnable` | anisotropic filtering on/off |
| `maxAnisotropy` | 1.0 ~ `VkPhysicalDeviceLimits::maxSamplerAnisotropy` |

> **스펙 원문 (VUID-VkSamplerCreateInfo-anisotropyEnable-01070)** If the `samplerAnisotropy` feature is not enabled, `anisotropyEnable` must be `VK_FALSE`.
>> feature가 꺼진 디바이스(보통 모바일 일부)에서는 무조건 OFF.

> **스펙 원문 (VUID-VkSamplerCreateInfo-anisotropyEnable-01071)** If `anisotropyEnable` is `VK_TRUE`, `maxAnisotropy` must be between 1.0 and `VkPhysicalDeviceLimits::maxSamplerAnisotropy`, inclusive.
>> 보통 16.0까지. 1.0은 사실상 비활성.

**성능/품질 트레이드오프:**

| maxAnisotropy | 품질 | 비용 |
|---------------|------|------|
| 1.0 | 트릴리니어와 동일 | baseline |
| 2.0 | 살짝 개선 | ~1.5x |
| 4.0 | 개선됨 | ~2x |
| 8.0 | 잘 보임 | ~3x |
| 16.0 | 사실상 최대 | ~4x |

**실전 팁**: 대부분의 경우 4 또는 8로 충분. 16은 잘 안 보임.

> **NOTE (스펙 발췌)** "For historical reasons, vendor implementations of anisotropic filtering interpret these sampler parameters in different ways, particularly in corner cases such as `magFilter, minFilter of VK_FILTER_NEAREST` or `maxAnisotropy equal to 1.0`. Applications should not expect consistent behavior in such cases, and should use anisotropic filtering only with parameters which are expected to give a quality improvement relative to LINEAR filtering."
>> NEAREST + anisotropy, anisotropy 1.0 같은 코너 케이스는 vendor마다 동작 다름. **LINEAR/LINEAR/LINEAR + anisotropy 2.0~16.0** 으로 쓰면 안정.

---

---

## 6. Depth Compare (PCF) — `compareEnable`, `compareOp`

그림자 매핑에서 깊이 텍스처를 **샘플링이 아니라 비교**할 때 사용.

```c
samplerInfo.compareEnable = VK_TRUE;
samplerInfo.compareOp     = VK_COMPARE_OP_LESS_OR_EQUAL;
```

| 필드 | 의미 |
|------|------|
| `compareEnable` | PCF on/off |
| `compareOp` | 비교 연산 (`VK_COMPARE_OP_LESS_OR_EQUAL`이 그림자에서 표준) |

> **스펙 원문 (VUID-VkSamplerCreateInfo-compareEnable-01423)** If `compareEnable` is `VK_TRUE`, the `reductionMode` member of `VkSamplerReductionModeCreateInfo` must be `VK_SAMPLER_REDUCTION_MODE_WEIGHTED_AVERAGE`.
>> PCF + min/max reduction은 호환 안 됨. reduction은 weighted average만.

**셰이더 측 (GLSL):**

```glsl
layout(set = 0, binding = 1) uniform sampler2DShadow shadowMap;

// texture() 대신 sampler2DShadow는 직접 비교 결과를 반환
float visibility = texture(shadowMap, vec3(shadowCoord.xy, shadowCoord.z));
// visibility ∈ [0, 1] (그림자 안 = 0, 밖 = 1)
```

`sampler2DShadow`를 사용하면 `texture()` 호출 시 uv.z를 비교 reference로 사용.

---

---

## 7. `unnormalizedCoordinates` — 픽셀 단위 텍스처 좌표

셰이더에서 `texture(samp, uv)` 호출 시 uv를 [0,1] 대신 **이미지 크기 단위 픽셀 좌표**로 사용.

| | `unnormalizedCoordinates = VK_FALSE` (기본) | `VK_TRUE` |
|---|------|------|
| uv 범위 | [0, 1] | [0, width) / [0, height) |
| view type 제한 | 없음 | `1D` 또는 `2D`만 |
| mipmap | 가능 | **불가** |
| anisotropy / compare | 가능 | **불가** |
| addressModeW | 의미 있음 | **무시됨** |
| addressMode U/V | 전체 | `CLAMP_TO_EDGE` 또는 `CLAMP_TO_BORDER`만 |

> **스펙 원문 (VUID-VkSamplerCreateInfo-unnormalizedCoordinates-01072~01077)** If `unnormalizedCoordinates` is `VK_TRUE`: `minFilter == magFilter`, `mipmapMode == NEAREST`, `minLod == maxLod == 0`, `anisotropyEnable == VK_FALSE`, `compareEnable == VK_FALSE`, addressMode는 `CLAMP_TO_EDGE`/`CLAMP_TO_BORDER`만.
>> **모든 고급 기능 off**. 픽셀 아트 2D UI/타일맵에 한정.

**실전**: 거의 안 씀. 호환성 문제로 게임 엔진도 거의 사용 안 함.

---

---

## 8. `flags` — 특수 sampler 동작

| 플래그 | 의미 | 필요 feature / extension |
|--------|------|------------------------|
| `SUBSAMPLED_BIT_EXT` | fragment density map과 함께 사용 | `VK_EXT_fragment_density_map` |
| `SUBSAMPLED_COARSE_RECONSTRUCTION_BIT_EXT` | coarse 재구성 허용 | 동일 |
| `NON_SEAMLESS_CUBE_MAP_BIT_EXT` | 큐브맵 면 사이 seamless 안 함 (전통 방식) | `nonSeamlessCubeMap` |
| `DESCRIPTOR_BUFFER_CAPTURE_REPLAY_BIT_EXT` | descriptor buffer 캡처/리플레이 | `descriptorBufferCaptureReplay` |
| `IMAGE_PROCESSING_BIT_QCOM` | QCOM image processing 확장 명령에만 사용 | `VK_QCOM_image_processing` |

> **스펙 원문 (VUID-VkSamplerCreateInfo-nonSeamlessCubeMap-06788)** If the `nonSeamlessCubeMap` feature is not enabled, `flags` must not include `VK_SAMPLER_CREATE_NON_SEAMLESS_CUBE_MAP_BIT_EXT`.

---

---

## 9. Reduction Mode (filter minmax)

`VkSamplerReductionModeCreateInfo`를 pNext에 체이닝해 필터 결과를 **가중평균** 대신 **min/max**로 합친다. SSAO/Shadow 등 단일 채널 비교에 유용.

```c
VkSamplerReductionModeCreateInfo rmci{};
rmci.sType = VK_STRUCTURE_TYPE_SAMPLER_REDUCTION_MODE_CREATE_INFO;
rmci.reductionMode = VK_SAMPLER_REDUCTION_MODE_MIN;

VkSamplerCreateInfo si{};
si.pNext = &rmci;
si.magFilter = VK_FILTER_LINEAR;  // minmax filter feature 필요
// ...
```

> **스펙 원문 (VUID-VkSamplerCreateInfo-pNext-06726)** If the `samplerFilterMinmax` feature is not enabled and the pNext chain includes a `VkSamplerReductionModeCreateInfo`, then the `reductionMode` must be `WEIGHTED_AVERAGE`.
>> feature 없으면 reduction mode가 있어도 무조건 weighted average.

---

---

## 10. 전체 전형적 코드

```c
VkSamplerCreateInfo si{};
si.sType                   = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO;
si.magFilter               = VK_FILTER_LINEAR;
si.minFilter               = VK_FILTER_LINEAR;
si.mipmapMode              = VK_SAMPLER_MIPMAP_MODE_LINEAR;
si.addressModeU            = VK_SAMPLER_ADDRESS_MODE_REPEAT;
si.addressModeV            = VK_SAMPLER_ADDRESS_MODE_REPEAT;
si.addressModeW            = VK_SAMPLER_ADDRESS_MODE_REPEAT;
si.mipLodBias              = 0.0f;
si.anisotropyEnable        = VK_TRUE;
si.maxAnisotropy           = 8.0f;
si.compareEnable           = VK_FALSE;
si.minLod                  = 0.0f;
si.maxLod                  = VK_LOD_CLAMP_NONE;
si.borderColor             = VK_BORDER_COLOR_FLOAT_OPAQUE_BLACK;
si.unnormalizedCoordinates = VK_FALSE;

VkSampler linearRepeatAniso8;
vkCreateSampler(device, &si, nullptr, &linearRepeatAniso8);
```

PCF sampler (그림자):

```c
si.compareEnable = VK_TRUE;
si.compareOp     = VK_COMPARE_OP_LESS_OR_EQUAL;
si.anisotropyEnable = VK_FALSE;
si.addressModeU/V/W = CLAMP_TO_BORDER;
si.borderColor       = VK_BORDER_COLOR_FLOAT_OPAQUE_WHITE;
si.magFilter = si.minFilter = VK_FILTER_LINEAR;
si.mipmapMode = VK_SAMPLER_MIPMAP_MODE_NEAREST;  // PCF는 보통 NEAREST mip
VkSampler pcfShadow;
vkCreateSampler(device, &si, nullptr, &pcfShadow);
```

---

---

## 11. 자주 빠지는 주의사항 모음

### 11.1. 필터 / address

- [ ] `VK_FILTER_CUBIC_EXT` 사용 + `anisotropyEnable = VK_TRUE` (VUID-magFilter-01081).
- [ ] `CLAMP_TO_BORDER` + `borderColor = VK_BORDER_COLOR_*_CUSTOM_EXT`인데 `VkSamplerCustomBorderColorCreateInfoEXT`가 pNext에 없음 (VUID-borderColor-04011).
- [ ] `customBorderColors` feature 비활성 + 커스텀 borderColor (VUID-customBorderColors-04085).
- [ ] `samplerMirrorClampToEdge` feature 비활성 + `MIRROR_CLAMP_TO_EDGE` (VUID-addressModeU-01079).
- [ ] YCbCr conversion + `anisotropyEnable`/`unnormalizedCoordinates`/비-CLAMP_TO_EDGE (VUID-addressModeU-01646).

### 11.2. LOD / mipmap

- [ ] `maxLod < minLod` (VUID-maxLod-01973).
- [ ] `mipLodBias` 절댓값 > `VkPhysicalDeviceLimits::maxSamplerLodBias` (VUID-mipLodBias-01069).
- [ ] `portability_subset` 환경에서 `samplerMipLodBias = VK_FALSE`인데 `mipLodBias != 0` (VUID-samplerMipLodBias-04467).
- [ ] mipmap이 없는 텍스처에 `mipmapMode = LINEAR` → LOD bias 계산 시 문제. **mipmap이 없는 텍스처는 `mipmapMode = NEAREST` + `minLod = maxLod = 0`** 이 안전.

### 11.3. Anisotropy

- [ ] `samplerAnisotropy` feature 비활성 + `anisotropyEnable = VK_TRUE` (VUID-anisotropyEnable-01070).
- [ ] `maxAnisotropy`가 한계 초과 (VUID-anisotropyEnable-01071).
- [ ] `anisotropyEnable = VK_TRUE`인데 `unnormalizedCoordinates = VK_TRUE` (VUID-unnormalizedCoordinates-01076).
- [ ] CUBIC 필터 + anisotropy (VUID-magFilter-01081).
- [ ] NEAREST + anisotropy 조합으로 vendor별 동작 차이 기대.

### 11.4. PCF / compare

- [ ] `compareEnable = VK_TRUE`인데 `compareOp` 무효 값 (VUID-compareEnable-01080).
- [ ] `compareEnable = VK_TRUE` + `VkSamplerReductionModeCreateInfo{reductionMode = MIN/MAX}` (VUID-compareEnable-01423).
- [ ] 셰이더에서 `sampler2DShadow`로 선언했는데 sampler의 `compareEnable = VK_FALSE` (또는 반대) — 일부는 셰이더 상태 우선.
- [ ] `compareEnable = VK_TRUE` + `unnormalizedCoordinates = VK_TRUE` (VUID-unnormalizedCoordinates-01077).

### 11.5. unnormalizedCoordinates

- [ ] `unnormalizedCoordinates = VK_TRUE` + mipmap/PCF/anisotropy (VUID-unnormalizedCoordinates-01072~01077).
- [ ] `unnormalizedCoordinates = VK_TRUE`인데 `addressModeW`가 `REPEAT` 등 → 무시되지만 의미가 헷갈림.
- [ ] 3D/큐브/배열 view에 unnormalized 사용 — 제한(`1D`/`2D`만).

### 11.6. Reduction mode / flags

- [ ] `samplerFilterMinmax` 비활성 + reduction pNext (VUID-pNext-06726). 명시적으로 `WEIGHTED_AVERAGE`만 가능.
- [ ] `nonSeamlessCubeMap` 비활성 + `NON_SEAMLESS_CUBE_MAP_BIT_EXT` (VUID-nonSeamlessCubeMap-06788).
- [ ] `SUBSAMPLED_BIT_EXT` + anisotropy/PCF/mipmap LINEAR (VUID-flags-02574..02580).
- [ ] `descriptorBufferCaptureReplay` 비활성 + `DESCRIPTOR_BUFFER_CAPTURE_REPLAY_BIT_EXT` (VUID-flags-08110).
- [ ] `VkOpaqueCaptureDescriptorDataCreateInfoEXT` pNext + 플래그 안 켬 (VUID-pNext-08111).

### 11.7. 일반 / 실전

- [ ] 디바이스 한계 조회 안 하고 `maxAnisotropy`를 16으로 무조건 설정.
- [ ] 모든 텍스처에 같은 sampler 하나만 쓰려고 함 — 일반적으로 **용도별로 여러 sampler 풀** 필요 (반복/클램프, PCF/일반, etc.).
- [ ] sampler 풀을 사용하지 않고 매 프레임 생성/파괴.
- [ ] 비등방 셰이딩에서 `mipLodBias` 음수로 sharp mip 강제 → anisotropy와 중복 효과, 성능만 나빠질 수 있음.
- [ ] 셰이더에서 `texture()` LOD-clamped sampler를 사용 + 명시적 LOD bias를 함께 줘서 LOD 계산 결과가 `maxLod` 초과.

---

---

## 12. 한 표로 보는 권장 sampler 프리셋

| 용도 | mag | min | mipmap | address | aniso | compare | 비고 |
|------|-----|-----|--------|---------|-------|---------|------|
| 3D 씬 일반 | LINEAR | LINEAR | LINEAR | REPEAT | 4~8 | FALSE | 트릴리니어 + aniso |
| UI 텍스처 | NEAREST | NEAREST | NEAREST | CLAMP_TO_EDGE | FALSE | FALSE | 격자 유지 |
| 데칼 | LINEAR | LINEAR | NEAREST | CLAMP_TO_EDGE | FALSE | FALSE | 알파 블렌드 |
| 그림자 PCF | LINEAR | LINEAR | NEAREST | CLAMP_TO_BORDER | FALSE | LESS_OR_EQUAL | border=OpaqueWhite |
| 큐브맵 환경 | LINEAR | LINEAR | LINEAR | (없음) | 4~8 | FALSE | 큐브 view |
| Normal map | LINEAR | LINEAR | LINEAR | REPEAT | 8 | FALSE | 셰이더에서 압축 해제 |
| HDR sky | LINEAR | LINEAR | LINEAR | CLAMP_TO_EDGE | FALSE | FALSE | tonemap 후 |

---

---

## 13. 빠른 참조 — 자주 보는 조합

| 의도 | 핵심 설정 |
|------|----------|
| 부드러운 3D 텍스처 | LINEAR/LINEAR/LINEAR + REPEAT + aniso 4 |
| 픽셀 정확 2D | NEAREST/NEAREST/NEAREST + CLAMP_TO_EDGE + aniso OFF |
| 그림자 부드럽게 | LINEAR/LINEAR/NEAREST + CLAMP_TO_BORDER + compare LESS_OR_EQUAL + border white |
| mip 없는 텍스처 | NEAREST/NEAREST/NEAREST + minLod=maxLod=0 |
| HDR env | LINEAR/LINEAR/LINEAR + CLAMP_TO_EDGE + aniso 8 |
| LUT lookup | NEAREST/NEAREST/NEAREST + CLAMP_TO_EDGE + aniso OFF |
