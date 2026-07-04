# Third-party notices

## OpenSpec (format & lifecycle conventions)

Plumbline's `propose` and `archive` commands follow the on-disk conventions of
[OpenSpec](https://github.com/Fission-AI/OpenSpec) — the `openspec/specs/` +
`openspec/changes/` layout, the requirement/scenario spec format
(`### Requirement:` / `#### Scenario:` with GIVEN/WHEN/THEN), the
ADDED/MODIFIED/REMOVED delta semantics, and the dated
`changes/archive/<date>-<slug>/` convention — so artifacts interop in both
directions between the two tools. Plumbline takes no code or runtime
dependency on OpenSpec; the conventions are reimplemented here.

OpenSpec is MIT-licensed:

    MIT License
    
    Copyright (c) 2024 OpenSpec Contributors
    
    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:
    
    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.
    
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
    
