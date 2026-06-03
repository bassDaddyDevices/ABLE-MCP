"""Synthetic Live-set XML fixtures for parser tests.

These mimic the subset of Live 12's ``.als`` schema we parse. They are
deliberately minimal — just enough to exercise each code path. When a real
Live 12 file becomes available, add it under ``tests/fixtures/real/`` and
write parity tests against it.
"""

from __future__ import annotations

import gzip
from pathlib import Path

EMPTY_SET = """<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="12" MinorVersion="12.0_99999" SchemaChangeCount="3" Creator="Ableton Live 12.0">
  <LiveSet>
    <MasterTrack>
      <DeviceChain>
        <Mixer>
          <Tempo>
            <Manual Value="120.0"/>
          </Tempo>
        </Mixer>
        <Devices/>
      </DeviceChain>
    </MasterTrack>
    <Tracks/>
    <Scenes/>
  </LiveSet>
</Ableton>
"""


FOUR_TRACK_SET = """<?xml version="1.0" encoding="UTF-8"?>
<Ableton MajorVersion="12" MinorVersion="12.0_99999" SchemaChangeCount="3" Creator="Ableton Live 12.0">
  <LiveSet>
    <MasterTrack>
      <DeviceChain>
        <Mixer>
          <Tempo>
            <Manual Value="124.0"/>
          </Tempo>
          <TimeSignatureNumerator Value="4"/>
          <TimeSignatureDenominator Value="4"/>
        </Mixer>
        <Devices>
          <Limiter>
            <UserName Value="Master Limiter"/>
          </Limiter>
        </Devices>
      </DeviceChain>
    </MasterTrack>
    <Tracks>
      <MidiTrack Id="1">
        <Name>
          <EffectiveName Value="Bass"/>
          <UserName Value="Bass"/>
        </Name>
        <ColorIndex Value="5"/>
        <DeviceChain>
          <Mixer><Mute Value="false"/><Solo Value="false"/></Mixer>
          <MainSequencer>
            <ClipSlotList>
              <ClipSlot Id="0">
                <ClipSlot>
                  <Value>
                    <MidiClip Id="10">
                      <Name Value="Bass Loop"/>
                      <CurrentStart Value="0"/>
                      <CurrentEnd Value="4"/>
                      <Loop><LoopOn Value="true"/></Loop>
                      <ColorIndex Value="5"/>
                      <Notes>
                        <KeyTracks>
                          <KeyTrack Id="0">
                            <MidiKey Value="36"/>
                            <Notes>
                              <MidiNoteEvent Time="0" Duration="0.5" Velocity="100" OffVelocity="64"/>
                              <MidiNoteEvent Time="1" Duration="0.5" Velocity="110" OffVelocity="64"/>
                            </Notes>
                          </KeyTrack>
                          <KeyTrack Id="1">
                            <MidiKey Value="43"/>
                            <Notes>
                              <MidiNoteEvent Time="2" Duration="0.5" Velocity="90" OffVelocity="64"/>
                            </Notes>
                          </KeyTrack>
                        </KeyTracks>
                      </Notes>
                    </MidiClip>
                  </Value>
                </ClipSlot>
              </ClipSlot>
            </ClipSlotList>
          </MainSequencer>
          <Devices>
            <Operator>
              <UserName Value="Bass Synth"/>
              <DeviceParameters>
                <Param><Name Value="Volume"/><Manual Value="0.8"/></Param>
              </DeviceParameters>
            </Operator>
          </Devices>
        </DeviceChain>
      </MidiTrack>

      <MidiTrack Id="2">
        <Name><EffectiveName Value="Lead"/></Name>
        <DeviceChain>
          <Mixer><Mute Value="false"/><Solo Value="false"/></Mixer>
          <MainSequencer>
            <ClipSlotList>
              <ClipSlot>
                <ClipSlot>
                  <Value>
                    <MidiClip Id="20">
                      <Name Value="Lead Empty"/>
                      <CurrentStart Value="0"/>
                      <CurrentEnd Value="4"/>
                      <Notes><KeyTracks/></Notes>
                    </MidiClip>
                  </Value>
                </ClipSlot>
              </ClipSlot>
            </ClipSlotList>
          </MainSequencer>
          <Devices/>
        </DeviceChain>
      </MidiTrack>

      <AudioTrack Id="3">
        <Name><EffectiveName Value="Drums"/></Name>
        <DeviceChain>
          <Mixer><Mute Value="true"/><Solo Value="false"/></Mixer>
          <MainSequencer>
            <Sample>
              <ArrangerAutomation>
                <Events>
                  <AudioClip Id="30">
                    <Name Value="Drums Loop"/>
                    <CurrentStart Value="0"/>
                    <CurrentEnd Value="8"/>
                    <Loop><LoopOn Value="true"/></Loop>
                    <SampleRef>
                      <FileRef>
                        <RelativePath Value="Samples/drums.wav"/>
                        <Path Value="/Users/x/Music/Samples/drums.wav"/>
                        <Name Value="drums.wav"/>
                      </FileRef>
                    </SampleRef>
                  </AudioClip>
                </Events>
              </ArrangerAutomation>
            </Sample>
          </MainSequencer>
          <Devices/>
        </DeviceChain>
      </AudioTrack>

      <AudioTrack Id="4">
        <Name><EffectiveName Value="Vox"/></Name>
        <DeviceChain>
          <Mixer><Mute Value="false"/><Solo Value="false"/></Mixer>
          <MainSequencer><Sample><ArrangerAutomation><Events/></ArrangerAutomation></Sample></MainSequencer>
          <Devices/>
        </DeviceChain>
      </AudioTrack>
    </Tracks>
    <Scenes>
      <Scene Id="0"><Name Value="Intro"/><Tempo Value="-1"/></Scene>
      <Scene Id="1"><Name Value="Drop"/><Tempo Value="-1"/></Scene>
    </Scenes>
  </LiveSet>
</Ableton>
"""


def write_als(xml: str, path: Path) -> Path:
    """Gzip-compress *xml* to *path*; return *path*."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wb") as f:
        f.write(xml.encode("utf-8"))
    return path
