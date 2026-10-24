"""Trusted bootstrap, mounted read-only inside each sandbox. Linux only."""
import ctypes
import errno
import os
import resource
import sys

READY = b'OTT_SANDBOX_READY\n'


def main():
    cpu, memory = int(sys.argv[1]), int(sys.argv[2])
    # Hard limits cannot be raised by agent code, including through ctypes.
    for kind, value in (
        (resource.RLIMIT_CPU, cpu),
        (resource.RLIMIT_AS, memory),
        (resource.RLIMIT_CORE, 0),
        (resource.RLIMIT_FSIZE, 0),
        (resource.RLIMIT_NOFILE, 32),
    ):
        resource.setrlimit(kind, (value, value))

    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), 'Cannot set no_new_privs')
    seccomp = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    seccomp.seccomp_init.argtypes = [ctypes.c_uint32]
    seccomp.seccomp_init.restype = ctypes.c_void_p
    seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    seccomp.seccomp_load.argtypes = [ctypes.c_void_p]
    seccomp.seccomp_release.argtypes = [ctypes.c_void_p]
    context = seccomp.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not context:
        raise RuntimeError('Cannot create seccomp filter')
    try:
        # No child processes/threads, sockets, namespace changes or process inspection.
        # Namespace/filesystem isolation is provided by bubblewrap, not this denylist.
        for name in (
            'clone', 'clone3', 'fork', 'vfork', 'socket', 'socketpair', 'ptrace',
            'process_vm_readv', 'process_vm_writev', 'mount', 'umount2', 'unshare',
            'setns', 'bpf', 'keyctl', 'add_key', 'request_key', 'userfaultfd',
            'io_uring_setup', 'open_by_handle_at', 'reboot', 'kexec_load',
        ):
            number = seccomp.seccomp_syscall_resolve_name(name.encode())
            if number >= 0 and seccomp.seccomp_rule_add(context, 0x50000 | errno.EPERM, number, 0) != 0:
                raise RuntimeError(f'Cannot block syscall {name}')
        if seccomp.seccomp_load(context) != 0:
            raise RuntimeError('Cannot load seccomp filter')
    finally:
        seccomp.seccomp_release(context)
    # The parent consumes this first line. Anything after it is agent stderr.
    os.write(2, READY)
    os.execv('/usr/bin/python3', ['python3', '-I', '-S', '-B', '/agent.py'])


if __name__ == '__main__':
    main()
