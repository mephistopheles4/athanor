# 0011. The state folder is .athanor in home

Date: 2026-10-19 · Status: accepted, amended by 0037 · Source: spec revision 5 on issue 1 (S4, T6)

The state folder is `.athanor` in the home folder on Windows, Linux and macOS,
or `ATHANOR_HOME` when it is set. File names there come from hashes, slot
numbers, pids, and random parts from Node's crypto source, never from repo
names or paths. On Linux and macOS the folder is set to mode 0700.
