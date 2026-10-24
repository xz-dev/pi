// Public SDK owns kinfo_proc's ABI; Rust sees only this fixed-width normalization.
#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <sys/proc.h>
#include <sys/sysctl.h>

struct pi_env_darwin_record {
    uint32_t pid, parent, group, state, uid, ruid;
    uint64_t seconds, micros;
};
_Static_assert(sizeof(struct pi_env_darwin_record) == 40, "Darwin normalization ABI");

// 0 = complete, -1 = fresh PID-specific empty result, -2 = invalid data; otherwise errno.
int pi_env_darwin_record(int32_t pid, struct pi_env_darwin_record *output) {
    struct kinfo_proc value;
    memset(&value, 0, sizeof(value));
    size_t size = sizeof(value);
    int name[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
    errno = 0;
    if (sysctl(name, 4, &value, &size, NULL, 0) != 0) return errno ? errno : EIO;
    // XNU's PID filter includes live/zombie lists; zero copied records means no such PID.
    if (size == 0) return -1;
    if (size != sizeof(value) || pid <= 0 || value.kp_proc.p_pid != pid
        || value.kp_proc.p_starttime.tv_sec <= 0 || value.kp_proc.p_starttime.tv_usec < 0
        || value.kp_proc.p_starttime.tv_usec >= 1000000) return -2;
    *output = (struct pi_env_darwin_record){
        (uint32_t)value.kp_proc.p_pid, (uint32_t)value.kp_eproc.e_ppid,
        (uint32_t)value.kp_eproc.e_pgid, (uint32_t)value.kp_proc.p_stat,
        value.kp_eproc.e_ucred.cr_uid, value.kp_eproc.e_pcred.p_ruid,
        (uint64_t)value.kp_proc.p_starttime.tv_sec,
        (uint64_t)value.kp_proc.p_starttime.tv_usec
    };
    return 0;
}
