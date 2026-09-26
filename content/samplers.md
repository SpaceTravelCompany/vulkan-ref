---
title: Sampler
slug: samplers
---

## 소개

`VkSampler`는 셰이더가 이미지를 읽고 보간하는 방식을 정의하는 불변(Immutable) 객체다. 필터 모드, 어드레스 모드, LOD 범위, 비등방성(Anisotropy) 필터링, PCF 깊이 비교 등 렌더링 품질을 결정하는 파라미터를 캡슐화한다. 디스크립터 세트에 결합 샘플러(Combined Image Sampler) 형태로 묶거나 분리된 샘플러로 바인딩하여 사용한다.

> **용어 정리**
> - **Filter**: 단일 텍셀 선택(`NEAREST`) 또는 인접 텍셀 선형 보간(`LINEAR`).
> - **Address Mode**: UV 좌표가 [0, 1] 범위를 벗어날 때의 처리 방식(`REPEAT`, `CLAMP_TO_EDGE` 등).
> - **Mipmap Mode**: 밉맵 레벨 사이의 보간 방식(`NEAREST`는 양선형, `LINEAR`는 삼선형).
> - **LOD Bias**: 하드웨어가 계산한 LOD 값에 더해지는 가중치. 음수는 선명해지지만 앨리어싱이 생기고 양수는 흐려짐.
> - **Anisotropy**: 비등방성 필터링. 비스듬한 각도에서 바라보는 표면의 텍스처 흐림을 방지.
> - **PCF (Percentage-Closer Filtering)**: 섀도 맵 깊이 비교 결과를 보간하여 그림자 경계면을 부드럽게 표현하는 기법.
> - **Unnormalized Coordinates**: [0, 1] 정규화 범위 대신 픽셀 텍셀 단위 정수 좌표([0, width), [0, height))를 직접 사용하는 모드.

이 문서는 `VkSamplerCreateInfo`의 주요 설정과 구현 시 주의사항을 정리한다.

---

## 1. `VkSamplerCreateInfo` 구조

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

> **스펙 참고** 일부 하드웨어 구현은 셰이더의 SPIR-V 선언(예: `OpTypeSampledImage`의 깊이 비교 속성)과 샘플러의 `compareEnable` 설정이 다를 때 셰이더 상태를 우선하기도 한다. 이식성을 확보하려면 셰이더 선언과 샘플러 설정을 반드시 일치시켜야 한다.

---

## 2. 필터 모드 — `magFilter` / `minFilter` / `mipmapMode`

| 필드 | 동작 시점 | 일반적 설정 |
|------|----------|------------|
| `magFilter` | 텍셀이 픽셀보다 클 때 (확대) | `NEAREST`(픽셀 아트) 또는 `LINEAR`(부드러운 표면) |
| `minFilter` | 텍셀이 픽셀보다 작을 때 (축소) | `LINEAR` 권장 |
| `mipmapMode` | 밉 레벨 간 보간 | `NEAREST`(양선형, 성능 우선) 또는 `LINEAR`(삼선형, 품질 우선) |

> **스펙 발췌 (VkFilter 정의)** `VK_FILTER_CUBIC_EXT`는 `VK_EXT_filter_cubic` 확장을 활성화한 디바이스에서만 지원된다. 큐빅 필터를 사용할 때는 `anisotropyEnable`을 반드시 `VK_FALSE`로 설정해야 한다(VUID-VkSamplerCreateInfo-magFilter-01081).

**자주 쓰이는 필터 조합:**

| 렌더링 목적 | magFilter | minFilter | mipmapMode | 최종 효과 |
|------------|-----------|-----------|------------|----------|
| 3D 일반 메쉬 | `LINEAR` | `LINEAR` | `LINEAR` | 삼선형(Trilinear) 필터링 |
| 2D 픽셀 아트 | `NEAREST` | `NEAREST` | `NEAREST` | 픽셀 경계 격자 유지 |
| 섀도 맵 (PCF) | `LINEAR` | `LINEAR` | `NEAREST` | 깊이 경계선 부드러운 안티앨리어싱 |
| 저사양 최적화 | `LINEAR` | `NEAREST` | `NEAREST` | 확대 시 선형, 축소/밉 시_NEAREST (삼선형보다 저렴) |

---

## 3. 어드레스 모드 — `addressModeU / V / W`

UV 좌표가 [0, 1] 범위를 벗어날 때의 래핑 동작을 축별로 제어한다. W축은 3D 볼륨 텍스처에 적용된다.

| 모드 | 동작 원리 | 주요 활용처 |
|------|----------|------------|
| `REPEAT` | 좌표를 1로 나눈 나머지(`uv mod 1`) 사용 | 타일형 벽면 바닥재 텍스처 |
| `MIRRORED_REPEAT` | 정수 경계마다 이미지를 뒤집으며 반복 | 대칭 무늬 텍스처 |
| `CLAMP_TO_EDGE` | 가장자리 픽셀 색상으로 고정 | UI 요소, 스프라이트, 데칼 |
| `CLAMP_TO_BORDER` | 정의된 `borderColor` 색상으로 채움 | 섀도 맵 투영 영역 외부, 글로우 효과 |
| `MIRROR_CLAMP_TO_EDGE` | 1회 반전 후 경계면 고정 | 환경 반사 텍스처 (1.2 코어) |

> **스펙 발췌 (VUID-VkSamplerCreateInfo-addressModeU-01079)** `samplerMirrorClampToEdge` 기능이나 `VK_KHR_sampler_mirror_clamp_to_edge` 확장이 활성화되지 않았다면 `MIRROR_CLAMP_TO_EDGE`를 사용할 수 없다.

> **스펙 발췌 (VUID-VkSamplerCreateInfo-addressModeU-01078)** 어드레스 모드로 `CLAMP_TO_BORDER`를 지정하는 경우 유효한 `borderColor` 열거형을 반드시 전달해야 한다.

> **스펙 발췌 (VUID-VkSamplerCreateInfo-addressModeU-01646)** YCbCr 색 변환 샘플러를 활성화할 때는 어드레스 모드가 `CLAMP_TO_EDGE`여야 하며 `anisotropyEnable`과 `unnormalizedCoordinates`는 모두 `VK_FALSE`여야 한다.

**경계 색상 (`VkBorderColor`):**

| 열거형 값 | 색상 값 | 용도 |
|-----------|---------|------|
| `FLOAT_TRANSPARENT_BLACK` | `(0, 0, 0, 0)` 부동소수점 | 가장 널리 쓰이는 기본값 |
| `INT_TRANSPARENT_BLACK` | `(0, 0, 0, 0)` 정수형 | 정수형 포맷 이미지 전용 |
| `FLOAT_OPAQUE_BLACK` / `WHITE` | 불투명 검정 / 흰색 | 섀도 맵 경계 클램핑 |
| `FLOAT_CUSTOM_EXT` / `INT_CUSTOM_EXT` | 임의 지정 색상 | `customBorderColors` 기능 활성화 시 |

---

## 4. 밉맵 및 LOD 제어

```c
samplerInfo.mipmapMode = VK_SAMPLER_MIPMAP_MODE_LINEAR;  // 삼선형 필터링
samplerInfo.mipLodBias  = 0.0f;
samplerInfo.minLod      = 0.0f;
samplerInfo.maxLod      = VK_LOD_CLAMP_NONE;             // 상한 클램핑 해제
```

| 필드 | 설명 | 주의사항 |
|------|------|----------|
| `mipmapMode` | 밉 레벨 사이의 보간 모드 | 밉맵이 없는 단일 이미지에는 `NEAREST` 지정 권장 |
| `mipLodBias` | 계산된 LOD에 가산할 오프셋 | `-maxSamplerLodBias` ~ `+maxSamplerLodBias` 범위 (VUID-VkSamplerCreateInfo-mipLodBias-01069) |
| `minLod` | LOD 최솟값 (가장 선명한 밉 제한) | 원본 밉보다 큰 값을 주면 원본 밉 사용 제한 |
| `maxLod` | LOD 최댓값 (가장 흐린 밉 제한) | `VK_LOD_CLAMP_NONE`(1000.0f) 설정 시 제한 없음 |

> **스펙 발췌 (VUID-VkSamplerCreateInfo-maxLod-01973)** `maxLod`는 항상 `minLod` 이상이어야 한다.

**권장 설정 지침:**
- 완전한 밉체인을 가진 3D 텍스처: `LINEAR` + `minLod = 0.0f` + `maxLod = VK_LOD_CLAMP_NONE` + `mipLodBias = 0.0f`.
- 밉맵이 없는 단일 레벨 UI 텍스처: `mipmapMode = NEAREST` + `minLod = 0.0f` + `maxLod = 0.0f`.

---

## 5. 비등방성 필터링 — `anisotropyEnable`, `maxAnisotropy`

카메라 시선과 비스듬하게 만나는 지면이나 벽면의 텍스처 디테일을 선명하게 보존한다.

```c
// samplerAnisotropy 기능 활성화 필수
samplerInfo.anisotropyEnable = VK_TRUE;
// 디바이스 지원 상한을 초과하지 않도록 클램핑
samplerInfo.maxAnisotropy    = std::min(8.0f, props.limits.maxSamplerAnisotropy);
```

| 필드 | 설명 |
|------|------|
| `anisotropyEnable` | 비등방성 필터링 활성화 여부 |
| `maxAnisotropy` | 1.0부터 `VkPhysicalDeviceLimits::maxSamplerAnisotropy` 사이의 값 |

> **스펙 발췌 (VUID-VkSamplerCreateInfo-anisotropyEnable-01070)** `samplerAnisotropy` 기능이 켜져 있지 않으면 `anisotropyEnable`은 반드시 `VK_FALSE`여야 한다.

> **스펙 발췌 (VUID-VkSamplerCreateInfo-anisotropyEnable-01071)** `anisotropyEnable`이 `VK_TRUE`일 때 `maxAnisotropy`는 1.0 이상, 디바이스의 `maxSamplerAnisotropy` 이하여야 한다. 1.0은 비등방성 필터링을 끈 것과 동일하다.

**하드웨어 지원 확인 및 비용 비교:**
- 데스크톱 외장 GPU는 통상 16.0까지 지원하지만, 모바일이나 내장 GPU는 지원 한도가 낮거나 해당 기능을 제공하지 않을 수 있다. 따라서 16.0을 임의로 단정하지 말고 반드시 디바이스 한계값을 조회해야 한다.
- 실무에서는 연산 비용과 품질을 고려하여 **4.0 또는 8.0**을 권장한다. 16.0은 8.0 대비 추가 성능 소모가 발생하지만 시각적 체감 차이는 미미하다.

> **스펙 참고** `NEAREST` 필터와 비등방성 필터링을 조합하거나 `maxAnisotropy`를 1.0으로 두는 경계 조건은 하드웨어 제조사마다 동작이 다를 수 있다. 안정적인 품질을 얻으려면 `LINEAR` 필터와 2.0 이상의 `maxAnisotropy` 조합을 사용하는 것이 좋다.

---

## 6. 깊이 비교 (PCF) — `compareEnable`, `compareOp`

섀도 매핑에서 깊이 버퍼를 샘플링할 때 부동소수점 색상값을 읽는 대신, 지정된 참조 깊이와 비교한 결과를 반환하도록 설정한다.

```c
samplerInfo.compareEnable = VK_TRUE;
samplerInfo.compareOp     = VK_COMPARE_OP_LESS_OR_EQUAL;
```

| 필드 | 설명 |
|------|------|
| `compareEnable` | 깊이 비교(PCF) 활성화 여부 |
| `compareOp` | 비교 연산자 (섀도 맵은 통상 `VK_COMPARE_OP_LESS_OR_EQUAL`) |

> **스펙 발췌 (VUID-VkSamplerCreateInfo-compareEnable-01423)** `compareEnable`이 `VK_TRUE`인 경우 `VkSamplerReductionModeCreateInfo`의 리덕션 모드는 반드시 `VK_SAMPLER_REDUCTION_MODE_WEIGHTED_AVERAGE`여야 한다. PCF는 Min/Max 리덕션과 함께 쓸 수 없다.

**셰이더 구현 (GLSL):**

```glsl
layout(set = 0, binding = 1) uniform sampler2DShadow shadowMap;

// texture() 호출 시 z 컴포넌트가 비교 참조값으로 사용됨
float shadowFactor = texture(shadowMap, vec3(shadowCoord.xy, shadowCoord.z));
// 반환값은 0.0(완전한 그림자)과 1.0(빛에 완전 노출) 사이의 보간된 가시성 수치
```

---

## 7. 정규화되지 않은 좌표계 — `unnormalizedCoordinates`

셰이더에서 텍스처를 읽을 때 [0, 1] 범위 대신 픽셀 텍셀 단위 좌표([0, width), [0, height))를 직접 사용한다.

| 항목 | `unnormalizedCoordinates = VK_FALSE` (기본값) | `VK_TRUE` |
|------|----------------------------------------------|-----------|
| UV 좌표 범위 | [0.0, 1.0] | [0, width), [0, height) |
| 이미지 뷰 타입 | 모든 차원(1D, 2D, 3D, Cube 등) 지원 | `1D`, `2D` 뷰만 허용 |
| 밉맵 지원 | 지원 | **사용 불가** (`minLod = maxLod = 0`) |
| 비등방성 / PCF | 지원 | **사용 불가** |
| 어드레스 모드 | 모든 모드 지원 | `CLAMP_TO_EDGE` 또는 `CLAMP_TO_BORDER`만 허용 |

> **스펙 발췌 (VUID-VkSamplerCreateInfo-unnormalizedCoordinates-01072~01077)** `unnormalizedCoordinates`가 `VK_TRUE`이면 `minFilter`와 `magFilter`가 같아야 하고, 밉맵은 `NEAREST`여야 하며, 비등방성 필터링과 깊이 비교는 모두 비활성화되어야 한다.

---

## 8. 특수 샘플러 플래그

| 플래그 | 용도 | 필요 기능/확장 |
|--------|------|--------------|
| `NON_SEAMLESS_CUBE_MAP_BIT_EXT` | 큐브맵 경계면 보간을 생략하는 구형 동작 모드 | `nonSeamlessCubeMap` |
| `SUBSAMPLED_BIT_EXT` | 가변 래스터화 밀도 맵(FDM)과 결합하여 사용 | `VK_EXT_fragment_density_map` |
| `DESCRIPTOR_BUFFER_CAPTURE_REPLAY_BIT_EXT` | 디스크립터 버퍼 캡처 및 리플레이 | `descriptorBufferCaptureReplay` |

---

## 9. 리덕션 모드 (Min / Max 필터링)

`VkSamplerReductionModeCreateInfo` 구조체를 pNext 체인에 연결하여 인접 텍셀들을 가중 평균 대신 최솟값이나 최댓값으로 합성한다. SSAO 깊이 축소나 계층형 깊이 버퍼(Hi-Z) 구성에 쓰인다.

```c
VkSamplerReductionModeCreateInfo rmci{};
rmci.sType = VK_STRUCTURE_TYPE_SAMPLER_REDUCTION_MODE_CREATE_INFO;
rmci.reductionMode = VK_SAMPLER_REDUCTION_MODE_MIN;

VkSamplerCreateInfo si{};
si.sType = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO;
si.pNext = &rmci;
si.magFilter = VK_FILTER_LINEAR;  // samplerFilterMinmax 기능 필요
```

---

## 10. 전형적 코드 예제

**범용 삼선형 비등방성 샘플러:**

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
si.maxAnisotropy           = std::min(8.0f, props.limits.maxSamplerAnisotropy);
si.compareEnable           = VK_FALSE;
si.minLod                  = 0.0f;
si.maxLod                  = VK_LOD_CLAMP_NONE;
si.borderColor             = VK_BORDER_COLOR_FLOAT_OPAQUE_BLACK;
si.unnormalizedCoordinates = VK_FALSE;

VkSampler linearRepeatSampler;
vkCreateSampler(device, &si, nullptr, &linearRepeatSampler);
```

**그림자 PCF 샘플러:**

```c
VkSamplerCreateInfo si{};
si.sType                   = VK_STRUCTURE_TYPE_SAMPLER_CREATE_INFO;
si.magFilter               = VK_FILTER_LINEAR;
si.minFilter               = VK_FILTER_LINEAR;
si.mipmapMode              = VK_SAMPLER_MIPMAP_MODE_NEAREST;
si.addressModeU            = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_BORDER;
si.addressModeV            = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_BORDER;
si.addressModeW            = VK_SAMPLER_ADDRESS_MODE_CLAMP_TO_BORDER;
si.borderColor             = VK_BORDER_COLOR_FLOAT_OPAQUE_WHITE;  // 그림자 외부를 빛에 노출
si.anisotropyEnable        = VK_FALSE;
si.compareEnable           = VK_TRUE;
si.compareOp               = VK_COMPARE_OP_LESS_OR_EQUAL;
si.minLod                  = 0.0f;
si.maxLod                  = 0.0f;

VkSampler shadowSampler;
vkCreateSampler(device, &si, nullptr, &shadowSampler);
```

---

## 11. 자주 발생하는 오류 점검 목록

### 11.1. 필터 및 어드레스 모드

- [ ] `VK_FILTER_CUBIC_EXT` 필터를 사용하면서 `anisotropyEnable`을 활성화 (VUID-magFilter-01081).
- [ ] `CLAMP_TO_BORDER`를 지정하고 커스텀 색상 비트를 쓰면서 pNext에 `VkSamplerCustomBorderColorCreateInfoEXT`를 누락 (VUID-borderColor-04011).
- [ ] `samplerMirrorClampToEdge` 기능 없이 `MIRROR_CLAMP_TO_EDGE` 모드 지정 (VUID-addressModeU-01079).
- [ ] 밉맵이 없는 텍스처에 `mipmapMode = LINEAR`를 지정하여 불필요한 LOD 보간 오버헤드 유발.

### 11.2. LOD / mipmap

- [ ] `maxLod < minLod` (VUID-maxLod-01973).
- [ ] `mipLodBias` 절댓값 > `maxSamplerLodBias` (VUID-mipLodBias-01069).
- [ ] `portability_subset` 환경에서 `samplerMipLodBias = VK_FALSE`인데 `mipLodBias != 0` (VUID-samplerMipLodBias-04467).
- [ ] 밉맵이 없는 텍스처에 `mipmapMode = LINEAR` → **밉맵 없는 텍스처는 `mipmapMode = NEAREST` + `minLod = maxLod = 0`이 안전**.

### 11.3. 비등방성 필터링

- [ ] `samplerAnisotropy` 기능 활성화 여부를 확인하지 않고 `anisotropyEnable = VK_TRUE` 지정 (VUID-anisotropyEnable-01070).
- [ ] 디바이스 한계값(`props.limits.maxSamplerAnisotropy`)을 질의하지 않고 `maxAnisotropy`를 16.0으로 하드코딩하여 검증 에러 유발.
- [ ] `anisotropyEnable = VK_TRUE`와 `unnormalizedCoordinates = VK_TRUE`를 동시에 지정 (VUID-unnormalizedCoordinates-01076).

### 11.4. 깊이 비교 (PCF)

- [ ] `compareEnable = VK_TRUE`인데 `compareOp`에 무효한 연산자 지정 (VUID-compareEnable-01080).
- [ ] `compareEnable = VK_TRUE` 상태에서 Min/Max 리덕션 모드를 결합 (VUID-compareEnable-01423).
- [ ] 셰이더에서 `sampler2DShadow`로 선언했으나 샘플러 생성 시 `compareEnable = VK_FALSE`로 설정 (또는 그 반대).

### 11.5. 구조 및 성능

- [ ] 샘플러를 풀링하지 않고 매 프레임 생성 및 파괴를 반복하는 문제 (초기화 시점에 용도별로 사전 생성 권장).
- [ ] 모든 텍스처에 단 하나의 샘플러만 적용하려다 클램핑과 반복 래핑이 충돌하는 문제.

---

## 12. 권장 샘플러 프리셋 요약

| 용도 | 필터 (mag/min/mip) | 어드레스 모드 | 비등방성 | 깊이 비교 | 특징 |
|------|-------------------|--------------|----------|----------|------|
| 3D 메쉬 표면 | LINEAR / LINEAR / LINEAR | `REPEAT` | 4.0 ~ 8.0 | `VK_FALSE` | 삼선형 보간 기본형 |
| UI 및 폰트 | NEAREST / NEAREST / NEAREST | `CLAMP_TO_EDGE` | 끄기 | `VK_FALSE` | 서브픽셀 번짐 방지 |
| 스프라이트 / 데칼 | LINEAR / LINEAR / NEAREST | `CLAMP_TO_EDGE` | 끄기 | `VK_FALSE` | 경계선 클램핑 |
| 섀도 맵 (PCF) | LINEAR / LINEAR / NEAREST | `CLAMP_TO_BORDER` | 끄기 | `LESS_OR_EQUAL` | 경계 흰색 채움 |
| 환경 큐브맵 | LINEAR / LINEAR / LINEAR | `CLAMP_TO_EDGE` | 4.0 ~ 8.0 | `VK_FALSE` | 큐브맵 뷰 전용 |
