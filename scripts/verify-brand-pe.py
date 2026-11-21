"""Read resources without starting an EXE, installing anything or touching Windows icon caches."""
import hashlib,io,json,struct,sys
from pathlib import Path
import pefile
from PIL import Image
root=Path(__file__).resolve().parents[1]
icon=(root/'build/icon.ico').read_bytes()
expected={}
for i in range(struct.unpack_from('<H',icon,4)[0]):
 w,h,_,_,planes,bits,length,off=struct.unpack_from('<BBBBHHII',icon,6+i*16);expected[w or 256]=icon[off:off+length]
def rgba(size,data):
 w=size if size<256 else 0
 with Image.open(io.BytesIO(struct.pack('<HHHBBBBHHII',0,1,1,w,w,0,0,1,32,len(data),22)+data)) as image:return image.convert('RGBA').tobytes()
def verify(exe):
 with pefile.PE(str(exe),fast_load=True) as pe:
  pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_RESOURCE']]);tree={e.id:e for e in pe.DIRECTORY_ENTRY_RESOURCE.entries}
  def take(e):
   d=e.directory.entries[0].data.struct;return pe.get_data(d.OffsetToData,d.Size)
  images={e.id:take(e) for e in tree[3].directory.entries};groups=[]
  for g in tree[14].directory.entries:
   raw=take(g);n=struct.unpack_from('<H',raw,4)[0];matches=[]
   for i in range(n):
    w,h,_,_,pl,bd,length,idx=struct.unpack_from('<BBBBHHIH',raw,6+i*14);sz=w or 256;data=images[idx]
    if sz in expected and (data==expected[sz] or rgba(sz,data)==rgba(sz,expected[sz])):matches.append(sz)
   groups.append({'id':g.id,'frames':n,'matching':sorted(matches)})
  result={'file':exe.name,'machine':hex(pe.FILE_HEADER.Machine),'firstGroup':groups[0], 'sha256':hashlib.sha256(exe.read_bytes()).hexdigest()}
  print(json.dumps(result));assert groups[0]['matching']==sorted(expected),f'{exe.name}: primary PE icon does not match all expected book frames'
  return result
if __name__=='__main__':
 for name in sys.argv[1:]:verify(Path(name))
