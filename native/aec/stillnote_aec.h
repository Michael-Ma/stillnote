#ifndef STILLNOTE_AEC_H
#define STILLNOTE_AEC_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct StillnoteAEC StillnoteAEC;
typedef struct {
  int64_t processed_samples;
  int64_t missing_reference_samples;
  double delay_ms;
  double erle_db;
  int64_t resets;
  double cpu_seconds;
  int64_t errors;
} StillnoteAECStats;
// Serialized calls, 16 kHz mono floats in [-1, 1]; indices are timeline sample numbers.
StillnoteAEC *stillnote_aec_create(int linear_only);
void stillnote_aec_destroy(StillnoteAEC *);
void stillnote_aec_reference(StillnoteAEC *, const float *, int count, int64_t index);
void stillnote_aec_capture(StillnoteAEC *, const float *, int count, int64_t index);
int stillnote_aec_pull(StillnoteAEC *, float *out, int capacity, int64_t *index);
void stillnote_aec_flush(StillnoteAEC *);
void stillnote_aec_reset(StillnoteAEC *);
void stillnote_aec_stats(StillnoteAEC *, StillnoteAECStats *);
#ifdef __cplusplus
}
#endif
#endif
