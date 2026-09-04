# CWK Custom Nodes Collection

A comprehensive collection of ComfyUI custom nodes for model loading, preset management, and latent image generation. This collection provides powerful tools to streamline your ComfyUI workflows with specialized nodes for advanced model operations, configuration management, and creative image generation.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Node Categories](#node-categories)
  - [Model Loader Nodes](#model-loader-nodes)
  - [Pipe Nodes](#pipe-nodes)
  - [WAN2.2 Nodes](#wan22-nodes)
  - [Utility Nodes](#utility-nodes)
- [Quick Start](#quick-start)
- [Usage Examples](#usage-examples)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)
- [Support](#support)

## Features

✨ **Rich Node Library** - Comprehensive collection of custom nodes covering model operations, pipeline management, and image generation

🎯 **Model Loading** - Advanced model loading capabilities with support for various model formats and optimization options

⚙️ **Preset Management** - Save, load, and manage workflow presets for consistent and reproducible results

🔄 **Pipe System** - Modular pipe nodes for creating complex, reusable workflows

🎨 **Latent Generation** - Sophisticated latent space manipulation and image generation tools

🚀 **Performance Optimized** - Designed for efficiency and speed

📦 **Well Documented** - Comprehensive documentation and examples

## Installation

### Prerequisites

- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) installed and configured
- Python 3.8 or higher
- Git

### Setup Instructions

1. Navigate to your ComfyUI installation directory:
```bash
cd ComfyUI/custom_nodes
```

2. Clone this repository:
```bash
git clone https://github.com/cowneko/CWK_CustomNodes_Collection.git
cd CWK_CustomNodes_Collection
```

3. Install any required dependencies (if applicable):
```bash
pip install -r requirements.txt
```

4. Restart ComfyUI to load the new custom nodes

5. The nodes should now appear in ComfyUI's node menu under their respective categories

### Updating

To update to the latest version:
```bash
cd ComfyUI/custom_nodes/CWK_CustomNodes_Collection
git pull origin main
```

## Node Categories

### Model Loader Nodes

Model loader nodes provide advanced capabilities for loading and managing various model types used in your workflows.

#### Available Model Loader Nodes:

- **CWK Model Loader** - Standard model loader with format detection and automatic optimization
  - Supports multiple model formats (Safetensors, CKPT, etc.)
  - Automatic device optimization (GPU/CPU)
  - Model validation and error checking
  - Memory management options

- **CWK Checkpoint Loader** - Specialized checkpoint loading with fine-tuning options
  - Load specific checkpoints
  - Layer-specific loading
  - Checkpoint validation
  - Preview loaded model information

- **CWK Model Manager** - Central model management interface
  - Load multiple models simultaneously
  - Model caching and optimization
  - Version tracking
  - Model metadata handling

- **CWK LoRA Loader** - LoRA weight loading and blending
  - Load single or multiple LoRA models
  - Strength parameter adjustment
  - LoRA blending capabilities
  - Compatibility checking

- **CWK Embedding Loader** - Text embedding and token handling
  - Load custom embeddings
  - Embedding validation
  - Token management

**Common Parameters:**
- Model path selection
- Device selection (auto/CPU/GPU)
- Memory optimization flags
- Precision settings (fp32/fp16)

### Pipe Nodes

Pipe nodes form the backbone of the workflow system, allowing you to create modular, reusable pipelines.

#### Available Pipe Nodes:

- **CWK Main Pipe** - Core pipeline orchestration node
  - Manages workflow state
  - Coordinates between different node types
  - Error handling and validation
  - Flow control

- **CWK Model Pipe** - Model-specific pipeline operations
  - Model routing
  - Sequential model loading
  - Model switching
  - State preservation

- **CWK Generation Pipe** - Image generation pipeline management
  - Generation settings management
  - Quality parameters
  - Output handling
  - Batch processing coordination

- **CWK Processing Pipe** - Data processing pipeline
  - Latent space processing
  - Image processing operations
  - Batch operations
  - Data transformation

- **CWK Preset Pipe** - Preset configuration management
  - Save current settings as presets
  - Load preset configurations
  - Preset switching
  - Configuration versioning

- **CWK Condition Pipe** - Conditional workflow branching
  - Conditional logic evaluation
  - Branch selection
  - Flow control based on parameters
  - Loop management

**Features:**
- Type checking and validation
- Automatic error recovery
- Performance monitoring
- Logging and debugging options

### WAN2.2 Nodes

Specialized nodes for WAN 2.2 compatibility and enhanced functionality.

#### Available WAN2.2 Nodes:

- **CWK WAN2.2 Sampler** - Advanced sampling with WAN2.2 features
  - Enhanced sampling algorithms
  - Custom noise scheduling
  - Advanced guidance options
  - Quality enhancements

- **CWK WAN2.2 Encoder** - WAN2.2 encoding operations
  - Image to latent encoding
  - Custom encoding parameters
  - Optimization options
  - Quality preservation

- **CWK WAN2.2 Decoder** - WAN2.2 decoding operations
  - Latent to image decoding
  - Quality upsampling
  - Post-processing options
  - Output formatting

- **CWK WAN2.2 Conditioning** - Advanced conditioning system
  - CLIP text conditioning
  - Weighted conditioning
  - Negative conditioning
  - Conditioning blending

- **CWK WAN2.2 Model Adapter** - Model compatibility layer
  - Automatic format conversion
  - Version compatibility handling
  - Performance optimization
  - Fallback options

**Advanced Features:**
- Enhanced quality algorithms
- Performance optimizations
- Extended parameter sets
- Advanced debugging options

### Utility Nodes

Essential utility nodes for workflow enhancement, debugging, and optimization.

#### Available Utility Nodes:

- **CWK Value Display** - Real-time value inspection
  - Display numeric values
  - Show text information
  - Format options
  - Logging capabilities

- **CWK Preset Manager** - Comprehensive preset handling
  - Save custom presets
  - Load preset configurations
  - Delete presets
  - Export/import presets

- **CWK Configuration Node** - Global configuration management
  - Set global parameters
  - Override defaults
  - Performance tuning
  - Debug options

- **CWK Logger** - Workflow logging and debugging
  - Log custom messages
  - Performance metrics
  - Error tracking
  - File output options

- **CWK Parameter Combiner** - Combine multiple parameters
  - Merge parameter sets
  - Override handling
  - Type checking
  - Validation

- **CWK Batch Processor** - Batch operation handling
  - Process multiple items
  - Parallel processing options
  - Result collection
  - Error aggregation

- **CWK Cache Manager** - Cache optimization
  - Clear cache
  - Cache statistics
  - Memory management
  - Performance monitoring

**Utilities Include:**
- Type conversion helpers
- Error handling utilities
- Performance profiling tools
- Configuration validators

## Quick Start

### Basic Workflow Setup

1. **Start ComfyUI** and open the web interface

2. **Add a Model Loader Node**:
   - Right-click in the canvas
   - Select `CWK Custom Nodes` → `Model Loader` → `CWK Model Loader`
   - Configure your model path and settings

3. **Add a Pipe Node**:
   - Add `CWK Main Pipe` to organize your workflow
   - Connect model loader output to pipe input

4. **Add Processing Nodes**:
   - Add generation or processing nodes as needed
   - Connect through the pipe system

5. **Run Your Workflow**:
   - Queue the workflow
   - Monitor progress in ComfyUI interface

### Example Workflow Patterns

#### Pattern 1: Simple Generation with Presets
```
Model Loader → Preset Pipe → Generation Pipe → Output
```

#### Pattern 2: Advanced Multi-Model Pipeline
```
Multiple Model Loaders → Model Pipe → Generation Pipe → Processing → Output
```

#### Pattern 3: Conditional Workflows
```
Model Loader → Condition Pipe → [Branch A or B] → Processing → Output
```

## Usage Examples

### Example 1: Loading and Using a Model

1. Add `CWK Model Loader` node
2. Select your model from the file browser
3. Set precision to `fp16` for memory optimization
4. Select your GPU device
5. Connect to downstream nodes

### Example 2: Using Presets

1. Configure your workflow with desired settings
2. Add `CWK Preset Manager` node
3. Set preset name (e.g., "My Workflow v1")
4. Click "Save Preset"
5. Later, load with one click for consistency

### Example 3: Batch Processing

1. Add `CWK Batch Processor` node
2. Configure batch size and processing options
3. Load multiple inputs
4. Enable parallel processing if desired
5. Run and collect results

### Example 4: Advanced Generation with WAN2.2

1. Load model with `CWK Model Loader`
2. Add `CWK WAN2.2 Sampler`
3. Configure sampling parameters
4. Add `CWK WAN2.2 Conditioning`
5. Set up text prompts and weights
6. Execute and monitor progress

## Configuration

### Global Settings

Configuration can be managed through:

1. **CWK Configuration Node** - Per-workflow configuration
2. **Config Files** - System-wide settings
3. **Environment Variables** - System-level overrides

### Performance Tuning

- **Memory Optimization**: Enable fp16 precision in model loaders
- **Batch Size**: Adjust batch processor settings for your GPU
- **Caching**: Use cache manager to optimize memory usage
- **Device Selection**: Manually set GPU/CPU allocation

### Debugging

Enable debug mode through:
- Add `CWK Logger` node to your workflow
- Set log level in configuration
- Use `CWK Value Display` nodes for inspection
- Check console output for detailed logs

## Troubleshooting

### Common Issues

**Issue: Nodes not appearing in ComfyUI menu**
- Solution: Restart ComfyUI completely
- Check that files are in `custom_nodes/CWK_CustomNodes_Collection/`
- Verify Python version is 3.8+

**Issue: Model loading errors**
- Solution: Verify model path is correct
- Check model file integrity
- Try different precision settings (fp16 vs fp32)
- Ensure sufficient GPU memory

**Issue: Out of memory errors**
- Solution: Enable fp16 precision
- Reduce batch size in processors
- Clear cache using `CWK Cache Manager`
- Close other applications

**Issue: Performance is slow**
- Solution: Use fp16 precision for faster inference
- Enable GPU acceleration
- Reduce image resolution
- Check system resource usage with logger

**Issue: Preset loading fails**
- Solution: Verify preset file exists and is readable
- Check preset compatibility with current version
- Try recreating the preset
- Check file permissions

### Getting Help

If you encounter issues:

1. Check this README and documentation
2. Review ComfyUI logs for error messages
3. Enable debug logging with `CWK Logger`
4. Search existing GitHub issues
5. Open a new issue with detailed error information

## Contributing

We welcome contributions to improve this collection!

### How to Contribute

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Add tests if applicable
5. Commit your changes (`git commit -am 'Add new feature'`)
6. Push to the branch (`git push origin feature/your-feature`)
7. Open a Pull Request

### Guidelines

- Follow existing code style and patterns
- Add documentation for new nodes
- Test thoroughly in ComfyUI
- Include usage examples
- Update README if adding new functionality

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

### MIT License Summary

You are free to:
- ✅ Use commercially
- ✅ Modify the code
- ✅ Distribute
- ✅ Use privately

Under the conditions that:
- ⚠️ Include the license and copyright notice
- ⚠️ State changes made to the code

## Support

### Getting Support

- **Issues**: Open an issue on [GitHub Issues](https://github.com/cowneko/CWK_CustomNodes_Collection/issues)
- **Discussions**: Use GitHub Discussions for questions and ideas
- **Documentation**: Check the detailed node documentation in this repository
- **ComfyUI Community**: Ask in ComfyUI community forums for general help

### Resources

- [ComfyUI GitHub Repository](https://github.com/comfyanonymous/ComfyUI)
- [ComfyUI Documentation](https://github.com/comfyanonymous/ComfyUI/wiki)
- [Community Discord](https://discord.gg/comfyui) - ComfyUI community support
- This Repository's Issues Section - Bug reports and feature requests

## Changelog

### Version 1.0.0 (Initial Release)
- Initial release of CWK Custom Nodes Collection
- Model Loader nodes suite
- Pipe system implementation
- WAN2.2 node support
- Utility nodes collection
- Complete documentation

## Credits

Created by **cowneko** for the ComfyUI community.

Special thanks to:
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) project
- All contributors and testers
- The amazing ComfyUI community

## Repository Information

- **Repository**: [cowneko/CWK_CustomNodes_Collection](https://github.com/cowneko/CWK_CustomNodes_Collection)
- **Main Branch**: main
- **License**: MIT
- **Status**: Active Development

---

## Additional Notes

### Performance Considerations

- Model loading time depends on model size and storage type
- GPU memory usage varies by model and settings
- Batch processing can significantly improve throughput
- Caching improves repeated operations

### Compatibility

- **ComfyUI**: Tested with recent versions
- **Python**: 3.8, 3.9, 3.10, 3.11+
- **OS**: Windows, Linux, macOS
- **GPU**: NVIDIA (CUDA), AMD (ROCm), CPU fallback

### Future Enhancements

Planned features for upcoming releases:
- Additional model format support
- Performance optimizations
- Extended WAN2.2 capabilities
- UI improvements
- More utility nodes

---

**Last Updated**: 2024

For the latest information, visit the [GitHub repository](https://github.com/cowneko/CWK_CustomNodes_Collection).
