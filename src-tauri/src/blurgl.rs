//! The blur of the translation windows on Windows 11, made by us (docs/HANDOFF.md 4-0aq). The system's own blur does not work there (the "weak" one is gone and the strong one has a colour cast), so the
//! picture of the game that the capture session of wgc.rs already has is cut at the place of a translation window and blurred on the graphics card. Nothing is read back to the processor, except
//! by the test (`probe`), which writes what it made to files so that the look of the blur can be seen and its time measured.
//!
//! The blur is the "dual Kawase" one: the picture is made half as large a few times (every step takes 5 samples), then as large again the same number of times (8 samples), all with the linear
//! sampler of the card. The more steps, the wider the blur and the cheaper it is per pixel (the small pictures are small). LEVELS says how many steps "weak" and "strong" have.
use std::ffi::c_void;

use windows::core::PCSTR;
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::ID3DBlob;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Buffer, D3D11_BIND_CONSTANT_BUFFER, D3D11_BUFFER_DESC, ID3D11Device, ID3D11DeviceContext, ID3D11PixelShader, ID3D11RenderTargetView, ID3D11SamplerState, ID3D11ShaderResourceView, ID3D11Texture2D, ID3D11VertexShader, ID3D11RasterizerState,
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX, D3D11_CPU_ACCESS_READ, D3D11_CULL_NONE, D3D11_FILL_SOLID, D3D11_FILTER_MIN_MAG_MIP_LINEAR, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
    D3D11_RASTERIZER_DESC, D3D11_SAMPLER_DESC, D3D11_TEXTURE2D_DESC, D3D11_TEXTURE_ADDRESS_CLAMP, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11_VIEWPORT,
};
use windows::Win32::Graphics::Direct3D::D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST;
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

/// The corners of a window are rounded by this many pixels, and its edge fades over this many pixels (the blur is mixed with the sharp picture of the game, more and more of it towards the edge: the
/// window is opaque, so it cannot be see-through at its edge; but it stands exactly over the picture it was cut from, so the sharp picture is what would be seen through it).
pub const CORNER: f32 = 4.0;
pub const FEATHER: f32 = 4.0;

/// How many steps of making the picture half as large the blur has: level 1 "weak", level 2 "strong" (the window setting `blur`). A step of the dual Kawase blur spreads about 2^steps pixels
/// of the picture; these two numbers are what to turn when the look has to change.
pub fn steps(level: u32) -> u32 { match level { 0 => 0, 1 => 2, _ => 4 } }

const HLSL: &str = r#"
Texture2D src : register(t0);
SamplerState smp : register(s0);
struct VSOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
VSOut vs(uint id : SV_VertexID) {
    VSOut o;
    float2 uv = float2((id << 1) & 2, id & 2);
    o.pos = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
    o.uv = uv;
    return o;
}
// the picture is made half as large: 5 samples (the middle counts four times), one pixel of the larger picture away at the corners
float4 down(VSOut i) : SV_Target {
    float w, h; src.GetDimensions(w, h);
    float2 t = 1.0 / float2(w, h);
    float4 c = src.Sample(smp, i.uv) * 4;
    c += src.Sample(smp, i.uv + float2(-t.x, -t.y));
    c += src.Sample(smp, i.uv + float2( t.x, -t.y));
    c += src.Sample(smp, i.uv + float2(-t.x,  t.y));
    c += src.Sample(smp, i.uv + float2( t.x,  t.y));
    return c / 8;
}
// the picture is made twice as large: 8 samples (the four on the axes once, the four at the corners twice)
float4 up(VSOut i) : SV_Target {
    float w, h; src.GetDimensions(w, h);
    float2 t = 0.5 / float2(w, h);
    float4 c = src.Sample(smp, i.uv + float2(-2 * t.x, 0));
    c += src.Sample(smp, i.uv + float2( 2 * t.x, 0));
    c += src.Sample(smp, i.uv + float2(0, -2 * t.y));
    c += src.Sample(smp, i.uv + float2(0,  2 * t.y));
    c += src.Sample(smp, i.uv + float2(-t.x, -t.y)) * 2;
    c += src.Sample(smp, i.uv + float2( t.x, -t.y)) * 2;
    c += src.Sample(smp, i.uv + float2(-t.x,  t.y)) * 2;
    c += src.Sample(smp, i.uv + float2( t.x,  t.y)) * 2;
    return c / 12;
}
// the blur mixed with the sharp picture: 1 inside, less and less towards the edge of the box (a box with rounded corners; a side that is not an edge of the pane is pushed far outside by the caller)
Texture2D ts : register(t1);
cbuffer C : register(b0) { float4 rc; float4 sh; }
float4 comp(VSOut i) : SV_Target {
    int3 p = int3(i.pos.xy, 0);
    float2 c = (rc.xy + rc.zw) * 0.5;
    float2 hs = (rc.zw - rc.xy) * 0.5;
    float r = sh.x;
    float2 q = abs(i.pos.xy - c) - (hs - r);
    float sdf = length(max(q, 0)) + min(max(q.x, q.y), 0) - r;
    float a = saturate(-sdf / max(sh.y, 0.001));
    return lerp(ts.Load(p), src.Load(p), a);
}
"#;

fn compile(entry: &str, target: &str) -> Result<ID3DBlob, String> {
    let (mut code, mut errors): (Option<ID3DBlob>, Option<ID3DBlob>) = (None, None);
    let entry_c = format!("{entry}\0");
    let target_c = format!("{target}\0");
    let r = unsafe { D3DCompile(HLSL.as_ptr() as *const c_void, HLSL.len(), PCSTR::null(), None, None, PCSTR(entry_c.as_ptr()), PCSTR(target_c.as_ptr()), 0, 0, &mut code, Some(&mut errors)) };
    if let Err(e) = r {
        let said = errors.map(|b| unsafe { String::from_utf8_lossy(std::slice::from_raw_parts(b.GetBufferPointer() as *const u8, b.GetBufferSize())).to_string() }).unwrap_or_default();
        return Err(format!("the shader {entry} did not compile: {e} {said}"));
    }
    code.ok_or_else(|| format!("the shader {entry} gave no code"))
}

fn blob_bytes(b: &ID3DBlob) -> &[u8] { unsafe { std::slice::from_raw_parts(b.GetBufferPointer() as *const u8, b.GetBufferSize()) } }

/// The shaders and states of the blur, made once for a graphics device (they belong to it).
pub struct Blur {
    vs: ID3D11VertexShader,
    down: ID3D11PixelShader,
    up: ID3D11PixelShader,
    comp: ID3D11PixelShader,
    cbuf: ID3D11Buffer,
    sampler: ID3D11SamplerState,
    raster: ID3D11RasterizerState,
}

/// The pictures of one blur (see `Blur::chain`): made for a size and a level, used again as long as both stay.
pub struct Chain { pub w: u32, pub h: u32, pub level: u32, levels: Vec<Level>, sharp: Level, fin: Level }

/// One picture of the chain: the texture, how to read it and how to draw into it.
struct Level { tex: ID3D11Texture2D, srv: ID3D11ShaderResourceView, rtv: ID3D11RenderTargetView, w: u32, h: u32 }

impl Blur {
    pub fn new(device: &ID3D11Device) -> Result<Blur, String> {
        unsafe {
            let (vs_b, down_b, up_b, comp_b) = (compile("vs", "vs_4_0")?, compile("down", "ps_4_0")?, compile("up", "ps_4_0")?, compile("comp", "ps_4_0")?);
            let mut vs = None; device.CreateVertexShader(blob_bytes(&vs_b), None, Some(&mut vs)).map_err(|e| format!("vertex shader: {e}"))?;
            let mut down = None; device.CreatePixelShader(blob_bytes(&down_b), None, Some(&mut down)).map_err(|e| format!("pixel shader: {e}"))?;
            let mut up = None; device.CreatePixelShader(blob_bytes(&up_b), None, Some(&mut up)).map_err(|e| format!("pixel shader: {e}"))?;
            let mut comp = None; device.CreatePixelShader(blob_bytes(&comp_b), None, Some(&mut comp)).map_err(|e| format!("pixel shader: {e}"))?;
            let bd = D3D11_BUFFER_DESC { ByteWidth: 32, Usage: D3D11_USAGE_DEFAULT, BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32, ..Default::default() };
            let mut cbuf = None; device.CreateBuffer(&bd, None, Some(&mut cbuf)).map_err(|e| format!("constant buffer: {e}"))?;
            let sd = D3D11_SAMPLER_DESC { Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR, AddressU: D3D11_TEXTURE_ADDRESS_CLAMP, AddressV: D3D11_TEXTURE_ADDRESS_CLAMP, AddressW: D3D11_TEXTURE_ADDRESS_CLAMP, MaxLOD: f32::MAX, ..Default::default() };
            let mut sampler = None; device.CreateSamplerState(&sd, Some(&mut sampler)).map_err(|e| format!("sampler: {e}"))?;
            let rd = D3D11_RASTERIZER_DESC { FillMode: D3D11_FILL_SOLID, CullMode: D3D11_CULL_NONE, DepthClipEnable: true.into(), ..Default::default() };
            let mut raster = None; device.CreateRasterizerState(&rd, Some(&mut raster)).map_err(|e| format!("rasterizer: {e}"))?;
            Ok(Blur { vs: vs.ok_or("no vertex shader")?, down: down.ok_or("no pixel shader")?, up: up.ok_or("no pixel shader")?, comp: comp.ok_or("no pixel shader")?, cbuf: cbuf.ok_or("no constant buffer")?, sampler: sampler.ok_or("no sampler")?, raster: raster.ok_or("no rasterizer")? })
        }
    }

    fn level(device: &ID3D11Device, w: u32, h: u32) -> Result<Level, String> {
        unsafe {
            let d = D3D11_TEXTURE2D_DESC { Width: w, Height: h, MipLevels: 1, ArraySize: 1, Format: DXGI_FORMAT_B8G8R8A8_UNORM, SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 }, Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32, CPUAccessFlags: 0, MiscFlags: 0 };
            let mut tex = None; device.CreateTexture2D(&d, None, Some(&mut tex)).map_err(|e| format!("texture {w}x{h}: {e}"))?;
            let tex = tex.ok_or("no texture")?;
            let mut srv = None; device.CreateShaderResourceView(&tex, None, Some(&mut srv)).map_err(|e| format!("view: {e}"))?;
            let mut rtv = None; device.CreateRenderTargetView(&tex, None, Some(&mut rtv)).map_err(|e| format!("target: {e}"))?;
            Ok(Level { tex, srv: srv.ok_or("no view")?, rtv: rtv.ok_or("no target")?, w, h })
        }
    }

    /// The textures of one blur: the size of the cut, then half as large (rounded up) `steps(level)` times, never smaller than 1 pixel. They are made once and used for every picture of a window
    /// of that size (a texture made at every picture was most of the time of the test).
    pub fn chain(&self, device: &ID3D11Device, w: u32, h: u32, level: u32) -> Result<Chain, String> {
        let (w, h, n) = (w.max(1), h.max(1), steps(level) as usize);
        let mut sizes = vec![(w, h)];
        for _ in 0..n { let (pw, ph) = *sizes.last().unwrap(); sizes.push((((pw + 1) / 2).max(1), ((ph + 1) / 2).max(1))); }
        let levels: Vec<Level> = sizes.iter().map(|&(sw, sh)| Self::level(device, sw, sh)).collect::<Result<_, _>>()?;
        Ok(Chain { w, h, level, levels, sharp: Self::level(device, w, h)?, fin: Self::level(device, w, h)? })
    }

    /// Cuts the rectangle (x, y, w, h: in pixels of `frame`) out of the picture `frame` and blurs it; the result is a texture of w x h (BGRA). The part of the rectangle
    /// that is outside the picture is not asked for: the caller has cut the rectangle to the picture. Everything stays on the graphics card.
    pub fn run(&self, device: &ID3D11Device, ctx: &ID3D11DeviceContext, frame: &ID3D11Texture2D, rect: [i32; 4], level: u32) -> Result<ID3D11Texture2D, String> {
        let chain = self.chain(device, rect[2].max(1) as u32, rect[3].max(1) as u32, level)?;
        Ok(self.run_chain(ctx, frame, (rect[0].max(0) as u32, rect[1].max(0) as u32), &chain, None).clone())
    }

    /// Blurs the cut that starts at (x, y) of `frame` and is as large as the chain. `edge`: None = the blur as it is; Some([x0, y0, x1, y1]) = the box (in pixels of the cut) whose edge fades to the
    /// sharp picture and whose corners are rounded (CORNER, FEATHER); a side that is not the edge of the pane is given far outside the cut. The result is a texture of the size of the cut.
    pub fn run_chain<'a>(&self, ctx: &ID3D11DeviceContext, frame: &ID3D11Texture2D, at: (u32, u32), chain: &'a Chain, edge: Option<[f32; 4]>) -> &'a ID3D11Texture2D {
        let (x, y, w, h) = (at.0, at.1, chain.w, chain.h);
        let (n, levels) = (chain.levels.len() - 1, &chain.levels);
        unsafe {
            let region = D3D11_BOX { left: x, top: y, front: 0, right: x + w, bottom: y + h, back: 1 };
            ctx.CopySubresourceRegion(&chain.sharp.tex, 0, 0, 0, 0, frame, 0, Some(&region));
            ctx.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            ctx.VSSetShader(&self.vs, None);
            ctx.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            ctx.RSSetState(&self.raster);
            // down: level i -> level i + 1
            for i in 0..n { self.pass(ctx, &self.down, if i == 0 { &chain.sharp } else { &levels[i] }, &levels[i + 1]); }
            // up: level i + 1 -> level i, until the size of the cut is there again
            for i in (0..n).rev() { self.pass(ctx, &self.up, &levels[i + 1], &levels[i]); }
            ctx.PSSetShaderResources(0, Some(&[None]));            // (the picture is not held as an input while it is read by others)
            let Some(b) = edge else { return &levels[0].tex };
            // the blur and the sharp picture mixed: the edge of the box fades out, the corners are round
            let c: [f32; 8] = [b[0], b[1], b[2], b[3], CORNER, FEATHER, 0.0, 0.0];
            ctx.UpdateSubresource(&self.cbuf, 0, None, c.as_ptr() as *const c_void, 0, 0);
            ctx.OMSetRenderTargets(Some(&[Some(chain.fin.rtv.clone())]), None);
            ctx.RSSetViewports(Some(&[D3D11_VIEWPORT { TopLeftX: 0.0, TopLeftY: 0.0, Width: chain.fin.w as f32, Height: chain.fin.h as f32, MinDepth: 0.0, MaxDepth: 1.0 }]));
            ctx.PSSetShader(&self.comp, None);
            ctx.PSSetConstantBuffers(0, Some(&[Some(self.cbuf.clone())]));
            ctx.PSSetShaderResources(0, Some(&[Some(levels[0].srv.clone()), Some(chain.sharp.srv.clone())]));
            ctx.Draw(3, 0);
            ctx.PSSetShaderResources(0, Some(&[None, None]));
            &chain.fin.tex
        }
    }

    unsafe fn pass(&self, ctx: &ID3D11DeviceContext, ps: &ID3D11PixelShader, from: &Level, to: &Level) {
        ctx.PSSetShaderResources(0, Some(&[None]));
        ctx.OMSetRenderTargets(Some(&[Some(to.rtv.clone())]), None);
        ctx.RSSetViewports(Some(&[D3D11_VIEWPORT { TopLeftX: 0.0, TopLeftY: 0.0, Width: to.w as f32, Height: to.h as f32, MinDepth: 0.0, MaxDepth: 1.0 }]));
        ctx.PSSetShader(ps, None);
        ctx.PSSetShaderResources(0, Some(&[Some(from.srv.clone())]));
        ctx.Draw(3, 0);
    }
}

/// The pixels of a texture of the card (BGRA, w * h * 4 bytes) read back to the processor: for the test only (this waits for the card to finish).
pub fn read_back(device: &ID3D11Device, ctx: &ID3D11DeviceContext, tex: &ID3D11Texture2D) -> Result<(u32, u32, Vec<u8>), String> {
    unsafe {
        let mut d = D3D11_TEXTURE2D_DESC::default(); tex.GetDesc(&mut d);
        let sd = D3D11_TEXTURE2D_DESC { Usage: D3D11_USAGE_STAGING, BindFlags: 0, CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32, MiscFlags: 0, ..d };
        let mut stage = None; device.CreateTexture2D(&sd, None, Some(&mut stage)).map_err(|e| format!("staging: {e}"))?;
        let stage = stage.ok_or("no staging texture")?;
        ctx.CopyResource(&stage, tex);
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        ctx.Map(&stage, 0, D3D11_MAP_READ, 0, Some(&mut m)).map_err(|e| format!("map: {e}"))?;
        let mut out = vec![0u8; (d.Width * d.Height * 4) as usize];
        for row in 0..d.Height as usize {
            let src = std::slice::from_raw_parts((m.pData as *const u8).add(row * m.RowPitch as usize), d.Width as usize * 4);
            out[row * d.Width as usize * 4..(row + 1) * d.Width as usize * 4].copy_from_slice(src);
        }
        ctx.Unmap(&stage, 0);
        Ok((d.Width, d.Height, out))
    }
}

/// The wait for the card: one pixel is read back, which cannot be done before everything asked of the card before it is done. (For measuring time.)
pub fn wait_done(device: &ID3D11Device, ctx: &ID3D11DeviceContext, tex: &ID3D11Texture2D) -> Result<(), String> {
    unsafe {
        let mut d = D3D11_TEXTURE2D_DESC::default(); tex.GetDesc(&mut d);
        let sd = D3D11_TEXTURE2D_DESC { Width: 1, Height: 1, Usage: D3D11_USAGE_STAGING, BindFlags: 0, CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32, MiscFlags: 0, ..d };
        let mut stage = None; device.CreateTexture2D(&sd, None, Some(&mut stage)).map_err(|e| format!("staging: {e}"))?;
        let stage = stage.ok_or("no staging texture")?;
        ctx.CopySubresourceRegion(&stage, 0, 0, 0, 0, tex, 0, Some(&D3D11_BOX { left: 0, top: 0, front: 0, right: 1, bottom: 1, back: 1 }));
        let mut m = D3D11_MAPPED_SUBRESOURCE::default();
        ctx.Map(&stage, 0, D3D11_MAP_READ, 0, Some(&mut m)).map_err(|e| format!("map: {e}"))?;
        ctx.Unmap(&stage, 0);
        Ok(())
    }
}

