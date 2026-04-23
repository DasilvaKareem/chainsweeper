import * as Phaser from 'phaser';
import './style.css';
import { BootScene } from './scenes/BootScene';
import { PreloadScene } from './scenes/PreloadScene';
import { MenuScene } from './scenes/MenuScene';
import { LobbyScene } from './scenes/LobbyScene';
import { OnlineLobbyScene } from './scenes/OnlineLobbyScene';
import { MatchScene } from './scenes/MatchScene';
import { ResultScene } from './scenes/ResultScene';
import { DialogueScene } from './scenes/DialogueScene';
import { VNScene } from './scenes/VNScene';
import { ArcadeRunScene } from './scenes/ArcadeRunScene';
import { SelectOperatorScene } from './scenes/SelectOperatorScene';
import { MultiplayerHubScene } from './scenes/MultiplayerHubScene';
import { PlotMapScene } from './scenes/PlotMapScene';
import { PlotScene } from './scenes/PlotScene';
import { PlotMarketScene } from './scenes/PlotMarketScene';

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0b0d12',
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: '100%',
    height: '100%',
  },
  scene: [
    BootScene,
    PreloadScene,
    MenuScene,
    LobbyScene,
    OnlineLobbyScene,
    SelectOperatorScene,
    ArcadeRunScene,
    DialogueScene,
    VNScene,
    MatchScene,
    ResultScene,
    MultiplayerHubScene,
    PlotMapScene,
    PlotScene,
    PlotMarketScene,
  ],
});
